#!/bin/bash
# Cut a Mac release from this Mac in one command while GitHub Actions stays disabled:
# build, sign, notarize and staple with tools/macos/release.py, tag the built commit,
# then publish the artifacts and propose the cask update with tools/macos/publish.py.
#
#   tools/macos/cut-release.sh VERSION BUILD [--dry-run]
#
# --dry-run runs every check and prints the three commands it would run, without
# building, tagging or publishing anything.
#
# VERSION is the marketing version (0.4.1); BUILD is the integer bundle version, which
# must be higher than the last published release's, because File Provider refuses an
# extension older than one it has already seen. The script refuses to run on a dirty
# tree, on a commit that is not on origin/main, or for a tag that already exists, and
# it tags only after the signed build succeeded, so a failed build leaves nothing behind
# but its output directory.
#
# Inputs it finds for you (override with the environment variable in brackets):
#   the Apple team, license organization and purchase URL from the repository variables
#   MACOS_TEAM_ID, MACOS_LICENSE_ORGANIZATION and MACOS_PURCHASE_URL
#   [FDRIVE_TEAM, FDRIVE_LICENSE_ORGANIZATION, FDRIVE_PURCHASE_URL];
#   the two Developer ID provisioning profiles by their names, "fdrive Mac Developer ID"
#   and "fdrive File Provider Developer ID", among the profiles Xcode has installed
#   [FDRIVE_APP_PROFILE, FDRIVE_EXTENSION_PROFILE];
#   the notarization credentials from the Keychain profile "fdrive-notary"
#   [FDRIVE_NOTARY_PROFILE], saved once with `xcrun notarytool store-credentials`.
# FDRIVE_REPO (default fredrikburmester/fdrive) names the GitHub repository.
set -euo pipefail

usage() { echo "usage: $0 VERSION BUILD [--dry-run]" >&2; exit 2; }
fail() { echo "cut-release: $*" >&2; exit 1; }
dry_run=false
if [[ ${3:-} == --dry-run ]]; then dry_run=true; set -- "$1" "$2"; fi
[[ $# -eq 2 ]] || usage
version=$1; build=$2
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "VERSION must look like 0.4.1, got '$version'"
[[ $build =~ ^[0-9]+$ ]] || fail "BUILD must be an integer, got '$build'"

repo=${FDRIVE_REPO:-fredrikburmester/fdrive}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
for tool in gh git python3 xcrun security plutil; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done

# The tag must name a commit that is already on main, built from a clean tree.
tag="macos-v$version"
[[ -z $(git status --porcelain --untracked-files=no) ]] || fail "the working tree has uncommitted changes"
git fetch --quiet origin main "refs/tags/*:refs/tags/*"
commit=$(git rev-parse HEAD)
git merge-base --is-ancestor "$commit" origin/main || fail "HEAD ($commit) is not on origin/main; check out the merged commit first"
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || fail "tag $tag already exists; pick a new version"
! gh release view "$tag" --repo "$repo" >/dev/null 2>&1 || fail "release $tag already exists on GitHub; pick a new version"

# A lower build than the last published one would be refused by File Provider on upgrade.
latest=$(gh release list --repo "$repo" --json tagName --jq '[.[].tagName | select(startswith("macos-v"))] | .[]' \
  | sort -V | tail -1 || true)
if [[ -n $latest ]]; then
  previous=$(gh release download "$latest" --repo "$repo" --pattern release.json --output - 2>/dev/null \
    | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["build"]))' || echo 0)
  (( build > previous )) || fail "BUILD $build is not above build $previous of $latest"
fi

team=${FDRIVE_TEAM:-$(gh variable get MACOS_TEAM_ID --repo "$repo")}
organization=${FDRIVE_LICENSE_ORGANIZATION:-$(gh variable get MACOS_LICENSE_ORGANIZATION --repo "$repo")}
purchase_url=${FDRIVE_PURCHASE_URL:-$(gh variable get MACOS_PURCHASE_URL --repo "$repo")}
[[ -n $team && -n $organization && -n $purchase_url ]] || fail "team, license organization and purchase URL are all required"

# Xcode names installed profiles by UUID; find ours by the name Apple gave them.
profile_named() {
  local wanted=$1 path
  for path in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.provisionprofile; do
    [[ -f $path ]] || continue
    if [[ $(security cms -D -i "$path" 2>/dev/null | plutil -extract Name raw - 2>/dev/null) == "$wanted" ]]; then
      echo "$path"; return 0
    fi
  done
  fail "no installed provisioning profile named '$wanted'; install it with Xcode or set the override"
}
app_profile=${FDRIVE_APP_PROFILE:-$(profile_named "fdrive Mac Developer ID")}
extension_profile=${FDRIVE_EXTENSION_PROFILE:-$(profile_named "fdrive File Provider Developer ID")}
[[ -f $app_profile && -f $extension_profile ]] || fail "provisioning profiles not found"

output=".fdrive-workflow/release-$version"
[[ ! -e $output ]] || fail "$output already exists; remove it or pick a new version"

echo "Cutting $tag (build $build) from $commit for $repo"
echo "  team $team, profiles $(basename "$app_profile") and $(basename "$extension_profile")"
echo "  output $output"

# Prints each step before running it; with --dry-run, printing is all it does.
run() {
  printf '+'; printf ' %q' "$@"; echo
  $dry_run || "$@"
}

# The Actions workflows that also run these are manual (and currently disabled
# to protect the hosted-minutes budget), so the local release path cannot rely
# on them: run the release-safety unit tests and the shared Swift tests first.
run python3 -m unittest discover -s tools/macos -p 'test_*.py'
run swift test --package-path apps/macos --scratch-path .fdrive-workflow/swift-build

run python3 tools/macos/release.py release \
  --version "$version" --build "$build" --team "$team" \
  --app-profile "$app_profile" --extension-profile "$extension_profile" \
  --notary-profile "${FDRIVE_NOTARY_PROFILE:-fdrive-notary}" \
  --license-organization "$organization" --purchase-url "$purchase_url" \
  --output "$output"

# Only a build that signed, notarized and stapled gets a tag.
run git tag "$tag" "$commit"
run git push origin "$tag"

run python3 tools/macos/publish.py --repo "$repo" --artifacts "$output/artifacts"

if $dry_run; then echo; echo "Dry run: nothing was built, tagged or published."; exit 0; fi

echo
echo "Published $tag. Merge the cask pull request to serve it through the tap, then upgrade:"
echo "  brew update && HOMEBREW_GITHUB_API_TOKEN=\"\$(gh auth token)\" brew upgrade --cask fdrive"
