#!/usr/bin/env python3
"""Build the Mac distribution. Only the release mode creates publishable artifacts."""

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shlex
import subprocess
import sys

from profiles import install_profile

ROOT = Path(__file__).resolve().parents[2]
APP_ID = "se.burmester.fdrive.mac"
EXTENSION_ID = APP_ID + ".fileprovider"


def run(*args, capture=False):
    result = subprocess.run([str(arg) for arg in args], check=True, capture_output=capture)
    return result.stdout if capture else b""


def version_value(value):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value):
        raise ValueError("Version must be three numbers, for example 0.1.0")
    return value


def license_settings(organization, purchase_url):
    """A release without a seller would ship with no trial or purchase gate at all."""
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", organization or ""):
        raise ValueError("Release requires --license-organization with the lowercase Polar organization UUID")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?", purchase_url or ""):
        raise ValueError("Release requires --purchase-url with a plain https:// address")
    # Sandbox keys cost nothing; a release must only ever accept production ones.
    return {"FdriveLicenseOrganization": organization, "FdrivePurchaseURL": purchase_url,
            "FdriveLicenseSandbox": ""}


def validate_entitlements(entitlements, team):
    expected = {
        "com.apple.security.app-sandbox": True,
        "com.apple.security.network.client": True,
        "com.apple.security.application-groups": [f"{team}.{APP_ID}"],
        "keychain-access-groups": [f"{team}.{APP_ID}.shared"],
    }
    for key, value in expected.items():
        if entitlements.get(key) != value:
            raise ValueError(f"Incorrect release entitlement: {key}")
    if entitlements.get("com.apple.security.get-task-allow"):
        raise ValueError("Release must not allow debugger attachment")


def validate_bundle(app, version, build, team=None, licensing=None):
    extension = app / "Contents/PlugIns/FdriveFileProvider.appex"
    for bundle, identifier in ((app, APP_ID), (extension, EXTENSION_ID)):
        with (bundle / "Contents/Info.plist").open("rb") as file:
            info = plistlib.load(file)
        for key, expected in {
            "CFBundleIdentifier": identifier,
            "CFBundleShortVersionString": version,
            "CFBundleVersion": build,
            "LSMinimumSystemVersion": "26.0",
        }.items():
            if info.get(key) != expected:
                raise ValueError(f"Unexpected {key} in {bundle.name}")
        # The extension enforces the trial on its own; it must name the same seller.
        for key, expected in (licensing or {}).items():
            if (bundle == app or key == "FdriveLicenseOrganization") and info.get(key, "") != expected:
                raise ValueError(f"{bundle.name} was built without the expected {key}")
        executable = bundle / "Contents/MacOS" / info["CFBundleExecutable"]
        if run("lipo", "-archs", executable, capture=True).decode().strip() != "arm64":
            raise ValueError("Release must contain the supported arm64 architecture")
        if team:
            run("codesign", "--verify", "--strict", "--verbose=2", bundle)
            # codesign writes descriptive information to stderr.
            details = subprocess.run(
                ["codesign", "-d", "--verbose=4", str(bundle)],
                check=True, capture_output=True, text=True,
            ).stderr
            if (f"TeamIdentifier={team}\n" not in details
                    or "Authority=Developer ID Application:" not in details
                    or "Timestamp=" not in details or "runtime" not in details):
                raise ValueError(f"{bundle.name} lacks timestamped Developer ID hardened signing")
            entitlements = plistlib.loads(run(
                "codesign", "-d", "--entitlements", ":-", bundle, capture=True,
            ))
            validate_entitlements(entitlements, team)


def notarize(path, profile, keychain, log_path):
    args = ["xcrun", "notarytool", "submit", path, "--keychain-profile", profile,
            "--wait", "--timeout", "30m", "--output-format", "json"]
    if keychain:
        args += ["--keychain", keychain]
    output = run(*args, capture=True)
    log_path.write_bytes(output)
    if json.loads(output).get("status") != "Accepted":
        raise ValueError(f"Apple did not accept {path.name}; see {log_path}")


def release(args):
    version_value(args.version)
    if not re.fullmatch(r"[1-9][0-9]*", args.build):
        raise ValueError("Build number must be a positive integer")
    if args.mode == "release" and not re.fullmatch(r"[A-Z0-9]{10}", args.team or ""):
        raise ValueError("Release requires --team with your ten-character Apple Team ID")
    if args.mode == "release" and (not args.app_profile or not args.extension_profile):
        raise ValueError("Release requires --app-profile and --extension-profile Developer ID profile paths")
    licensing = license_settings(args.license_organization, args.purchase_url) if args.mode == "release" else None
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Output directory already exists; choose a fresh directory")
    if args.mode == "release":
        command = ["security", "find-identity", "-v", "-p", "codesigning"]
        if args.keychain:
            command.append(args.keychain)
        identities = run(*command, capture=True).decode()
        matches = re.findall(
            rf'([A-F0-9]{{40}}) "Developer ID Application: [^"\n]+ \({args.team}\)"',
            identities,
        )
        if not matches:
            raise ValueError("No Developer ID Application private key/certificate for this team")
        identity = matches[0]
        app_profile = install_profile(args.app_profile, args.team, APP_ID, identity)
        extension_profile = install_profile(args.extension_profile, args.team, EXTENSION_ID, identity)
    output.mkdir(parents=True)
    archive = output / "fdrive.xcarchive"
    command = ["xcodebuild", "-project", ROOT / "apps/macos/fdrive.xcodeproj",
               "-scheme", "fdrive", "-configuration", "Release",
               "-destination", "generic/platform=macOS", "-archivePath", archive,
               "-derivedDataPath", output / "DerivedData", "-hideShellScriptEnvironment",
               f"MARKETING_VERSION={args.version}", f"CURRENT_PROJECT_VERSION={args.build}"]
    if args.mode == "check":
        command += ["CODE_SIGNING_ALLOWED=NO"]
    else:
        flags = "--timestamp"
        if args.keychain:
            flags += " --keychain " + shlex.quote(str(args.keychain))
        command += ["CODE_SIGN_STYLE=Manual", f"DEVELOPMENT_TEAM={args.team}",
                    f"CODE_SIGN_IDENTITY={identity}", f"OTHER_CODE_SIGN_FLAGS={flags}",
                    f"FDRIVE_APP_PROFILE={app_profile}", f"FDRIVE_EXTENSION_PROFILE={extension_profile}",
                    f"FDRIVE_LICENSE_ORGANIZATION={args.license_organization}",
                    f"FDRIVE_PURCHASE_URL={args.purchase_url}", "FDRIVE_LICENSE_SANDBOX="]
    run(*command, "archive")
    if args.mode == "check":
        validate_bundle(archive / "Products/Applications/FDrive.app", args.version, args.build)
        print("Unsigned Release archive verified. No distributable DMG was created.")
        return

    export_options = output / "ExportOptions.plist"
    export_options.write_bytes(plistlib.dumps({
        "method": "developer-id", "destination": "export", "teamID": args.team,
        "signingStyle": "manual", "signingCertificate": identity,
        "manageAppVersionAndBuildNumber": False,
        "provisioningProfiles": {APP_ID: app_profile, EXTENSION_ID: extension_profile},
    }))
    run("xcodebuild", "-exportArchive", "-archivePath", archive,
        "-exportOptionsPlist", export_options, "-exportPath", output / "export")
    app = output / "export/FDrive.app"
    validate_bundle(app, args.version, args.build, args.team, licensing)
    zip_path = output / "fdrive-notarization.zip"
    run("ditto", "-c", "-k", "--keepParent", app, zip_path)
    notarize(zip_path, args.notary_profile, args.keychain, output / "app-notary.json")
    run("xcrun", "stapler", "staple", app)
    run("xcrun", "stapler", "validate", app)
    run("spctl", "--assess", "--type", "execute", "--verbose=2", app)

    staging = output / "dmg-root"
    staging.mkdir()
    run("ditto", app, staging / "FDrive.app")
    (staging / "Applications").symlink_to("/Applications")
    artifacts = output / "artifacts"
    artifacts.mkdir()
    dmg = artifacts / f"fdrive-{args.version}-arm64.dmg"
    run("hdiutil", "create", "-volname", "FDrive", "-srcfolder", staging,
        "-format", "UDZO", "-ov", dmg)
    sign = ["codesign", "--sign", identity, "--timestamp"]
    if args.keychain:
        sign += ["--keychain", args.keychain]
    run(*sign, dmg)
    notarize(dmg, args.notary_profile, args.keychain, output / "dmg-notary.json")
    run("xcrun", "stapler", "staple", dmg)
    run("xcrun", "stapler", "validate", dmg)
    run("codesign", "--verify", "--strict", dmg)
    run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", dmg)
    digest = hashlib.sha256(dmg.read_bytes()).hexdigest()
    (artifacts / "SHA256SUMS").write_text(f"{digest}  {dmg.name}\n")
    (artifacts / "release.json").write_text(json.dumps({
        "version": args.version, "build": args.build, "filename": dmg.name,
        "sha256": digest, "notarized": True,
    }, indent=2) + "\n")
    print(f"Signed, notarized DMG ready: {dmg}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "release"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--team")
    parser.add_argument("--app-profile", type=Path)
    parser.add_argument("--extension-profile", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--keychain", type=Path)
    parser.add_argument("--notary-profile", default="fdrive-notary")
    parser.add_argument("--license-organization")
    parser.add_argument("--purchase-url")
    args = parser.parse_args()
    try:
        release(args)
    except (ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
