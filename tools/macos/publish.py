#!/usr/bin/env python3
"""Publish verified artifacts, then propose the Homebrew cask update on main."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from release import version_value


def gh(*args, payload=None):
    command = ["gh", *[str(arg) for arg in args]]
    if payload is not None:
        command += ["--input", "-"]
    result = subprocess.run(command, input=json.dumps(payload).encode() if payload is not None else None,
                            check=True, capture_output=True)
    return result.stdout.decode()


def repository_value(value):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise ValueError("Expected GitHub owner/repository")
    return value


def read_manifest(directory):
    manifest = json.loads((directory / "release.json").read_text())
    version = version_value(manifest["version"])
    filename = f"fdrive-{version}-arm64.dmg"
    if manifest.get("notarized") is not True or manifest.get("filename") != filename:
        raise ValueError("Only a notarized release manifest with the expected filename can publish")
    digest = hashlib.sha256((directory / filename).read_bytes()).hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError("DMG checksum does not match the release manifest")
    if (directory / "SHA256SUMS").read_text() != f"{digest}  {filename}\n":
        raise ValueError("SHA256SUMS does not match the DMG")
    return manifest


def render_cask(repo, version, digest, asset_id):
    repository_value(repo)
    version_value(version)
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or not isinstance(asset_id, int) or asset_id <= 0:
        raise ValueError("Invalid release asset metadata")
    return f'''cask "fdrive" do
  version "{version}"
  sha256 "{digest}"

  # Private releases use GitHub's authenticated asset endpoint. The ordinary URL
  # works without a token after the source repository becomes public.
  if ENV["HOMEBREW_GITHUB_API_TOKEN"].to_s.empty?
    url "https://github.com/{repo}/releases/download/macos-v#{{version}}/fdrive-#{{version}}-arm64.dmg"
  else
    url "https://api.github.com/repos/{repo}/releases/assets/{asset_id}",
        header: ["Accept: application/octet-stream",
                 "Authorization: Bearer #{{ENV.fetch("HOMEBREW_GITHUB_API_TOKEN")}}"]
  end
  name "FDrive"
  desc "Browse remote storage in Finder with downloads on demand"
  homepage "https://github.com/{repo}"

  depends_on arch: :arm64
  depends_on macos: ">= :tahoe"

  app "FDrive.app"

  caveats <<~EOS
    Connect using your fdrive HTTPS web address, then enable the Finder location.
    Quit FDrive before upgrading. Disconnect locations in FDrive before uninstalling.
  EOS
end
'''


def propose_cask(repo, version, cask):
    repository_value(repo)
    version_value(version)
    branch = f"release/macos-cask-{version}"
    metadata = json.loads(gh("api", f"repos/{repo}"))
    base = metadata["default_branch"]
    sha = json.loads(gh("api", f"repos/{repo}/git/ref/heads/{base}"))["object"]["sha"]
    refs = json.loads(gh("api", f"repos/{repo}/git/matching-refs/heads/{branch}"))
    if not any(ref["ref"] == f"refs/heads/{branch}" for ref in refs):
        gh("api", "--method", "POST", f"repos/{repo}/git/refs",
           payload={"ref": f"refs/heads/{branch}", "sha": sha})
    tree = json.loads(gh("api", f"repos/{repo}/git/trees/{branch}?recursive=1"))
    existing = next((item for item in tree["tree"] if item["path"] == "Casks/fdrive.rb"), None)
    payload = {"message": f"Update fdrive Mac cask to {version}", "branch": branch,
               "content": base64.b64encode(cask.encode()).decode()}
    if existing:
        payload["sha"] = existing["sha"]
    gh("api", "--method", "PUT", f"repos/{repo}/contents/Casks/fdrive.rb", payload=payload)
    pulls = json.loads(gh("pr", "list", "--repo", repo, "--head", branch, "--json", "url"))
    if pulls:
        print(pulls[0]["url"])
    else:
        try:
            print(gh("pr", "create", "--repo", repo, "--head", branch, "--base", base,
                     "--title", f"Update fdrive Mac cask to {version}", "--body",
                     f"Install the signed, notarized macos-v{version} release through Homebrew. "
                     "The cask pins the final DMG checksum and supports authenticated private downloads. "
                     "The release workflow verified both the app and DMG before publishing."))
        except subprocess.CalledProcessError:
            print("Cask branch saved; GitHub did not allow the PR to be created. Open it here:")
            print(f"https://github.com/{repo}/compare/{base}...{branch}?expand=1")


def publish(repo, directory):
    repository_value(repo)
    manifest = read_manifest(directory)
    version = manifest["version"]
    tag = f"macos-v{version}"
    # No replacement of an existing release or checksummed asset, even on retries.
    probe = subprocess.run(["gh", "release", "view", tag, "--repo", repo], capture_output=True)
    if probe.returncode == 0:
        raise ValueError("Release already exists. Use a new version; use --cask-only to repair a cask PR")
    notes = (f"Native macOS development preview {version}. Requires macOS 26+ and Apple silicon.\n\n"
             "Download the DMG, move FDrive to Applications, then connect to your fdrive HTTPS server. "
             "Finder access is read-only; files download when opened.\n\n"
             "App and DMG are Developer ID signed, notarized and stapled. "
             "Broader beta qualification is ongoing. SHA256SUMS contains the final DMG checksum.\n")
    command = ["release", "create", tag, "--repo", repo, "--verify-tag", "--draft",
               "--title", f"FDrive for Mac {version}", "--notes", notes]
    if version.startswith("0."):
        command.append("--prerelease")
    gh(*command)
    gh("release", "upload", tag, "--repo", repo, directory / manifest["filename"],
       directory / "SHA256SUMS", directory / "release.json")
    # The numeric REST asset ID is returned by the release API, not gh's GraphQL node ID.
    release_info = json.loads(gh("api", f"repos/{repo}/releases/tags/{tag}"))
    asset_id = next(item["id"] for item in release_info["assets"] if item["name"] == manifest["filename"])
    cask = render_cask(repo, version, manifest["sha256"], asset_id)
    cask_path = directory / "fdrive.rb"
    cask_path.write_text(cask)
    gh("release", "upload", tag, "--repo", repo, cask_path)
    gh("release", "edit", tag, "--repo", repo, "--draft=false", "--latest=false")
    print(f"Published https://github.com/{repo}/releases/tag/{tag}")
    propose_cask(repo, version, cask)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--cask-only", metavar="VERSION")
    args = parser.parse_args()
    try:
        repository_value(args.repo)
        if args.cask_only:
            version_value(args.cask_only)
            with tempfile.TemporaryDirectory() as directory:
                gh("release", "download", f"macos-v{args.cask_only}", "--repo", args.repo,
                   "--pattern", "fdrive.rb", "--dir", directory)
                propose_cask(args.repo, args.cask_only, (Path(directory) / "fdrive.rb").read_text())
        elif args.artifacts:
            publish(args.repo, args.artifacts)
        else:
            parser.error("Provide --artifacts or --cask-only")
    except (ValueError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode(), file=sys.stderr)
        sys.exit(str(error))


if __name__ == "__main__":
    main()
