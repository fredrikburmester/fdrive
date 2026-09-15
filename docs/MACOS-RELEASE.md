# Mac releases and Homebrew

The source repository also acts as the Homebrew tap. GitHub releases have the same visibility
as the repository: downloads require authentication while it is private; after it becomes
public, the same versioned DMG URLs work without authentication. No second repository or
cross-repository access token is needed.

GitHub Actions is currently disabled for this repository to control hosted runner costs.
Keep it disabled unless the owner explicitly requests re-enabling it. The local signed release
command below remains available; merging this workflow does not enable Actions.

## Apple and GitHub setup

Use the same Apple team for the app, extension and all subsequent releases. Changing teams
changes App Group/Keychain ownership and is not an ordinary app upgrade. This repository
is maintained with **Fredrik Burmester**, team **MWD5K362T8**, and GitHub account
**fredrikburmester**. Keep all signing assets in that team.

1. In Apple Developer → Certificates, create a **Developer ID Application** certificate.
   Keep its private key on the Mac where the certificate request was generated. Export only
   that signing identity to a password-protected `.p12`. Apple Development and Apple
   Distribution identities do not substitute for Developer ID Application.
2. In App Store Connect → Users and Access → Integrations → Team Keys, create a dedicated
   **Developer** key for this app's CI. Download the `.p8` once and keep it securely. Team keys
   have access across the account's apps; do not grant Admin access for notarization.
3. Register the explicit App IDs `se.burmester.fdrive.mac` and
   `se.burmester.fdrive.mac.fileprovider` under the same team. Create a **Developer ID**
   provisioning profile for each, selecting the new certificate, and download both profiles.
4. From this checkout, configure GitHub using local prompts. The command sends private keys
   directly to GitHub Secrets; it never writes them into repository files or prints them:

   ```sh
   python3 tools/macos/configure-ci.py --repo fredrikburmester/fdrive-web --team MWD5K362T8
   ```

The resulting GitHub configuration is:

| Kind | Names |
| --- | --- |
| Secrets | `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_NOTARY_KEY_BASE64`, `MACOS_APP_PROFILE_BASE64`, `MACOS_EXTENSION_PROFILE_BASE64` |
| Variables | `MACOS_TEAM_ID`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_ISSUER_ID` |

The hosted workflow imports the identity into a temporary keychain, validates notarization
credentials against Apple, and removes key files/keychain when done. It does not print the
secret-bearing Apple command output or upload signing logs, keys, archives or debug symbols.
Never run `ci-signing.py` on a personal Mac: it is for disposable GitHub-hosted runners.

The release publisher needs `contents: write`; the cask update requests `pull-requests: write`.
If repository policy permits bot-created PRs, the workflow opens the update PR. Otherwise it
saves the cask branch and prints a comparison link for the owner to open the PR. It never
approves/merges PRs or changes repository-wide permissions. Default token permissions remain
read-only. An owner can also create the cask PR with:

```sh
python3 tools/macos/publish.py --repo OWNER/REPOSITORY --cask-only 0.1.0
```

## Build and publish

The ordinary [native build](MACOS.md#build-and-verify) remains unsigned or
Apple Development signed. Check the optimized Release archive without credentials:

```sh
python3 tools/macos/release.py check \
  --version 0.1.0 --build 1 --output .fdrive-workflow/release-check
```

Choose a fresh output directory on each run. This mode validates the app/extension IDs,
versions, architecture and macOS minimum; it produces no distributable DMG.

After configuring secrets and merging the workflow, run **macOS release** manually with a
version to build a signed/notarized Actions artifact without publishing. Publishing requires
a `macos-vX.Y.Z` tag pointing to a commit already merged into `main`:

```sh
git tag macos-v0.1.0 COMMIT_ON_MAIN
git push origin macos-v0.1.0
```

The release workflow runs release script tests and Swift tests, archives/exports Release, verifies
the app and extension's Developer ID team, timestamp, hardened runtime and shared entitlements,
notarizes/staples the app, creates a DMG, then signs/notarizes/staples and assesses the DMG.
Only successful artifacts reach publication. Checksums are calculated after stapling.

GitHub Releases receives the DMG, `SHA256SUMS`, `release.json` and `fdrive.rb`. Releases with a
`0.` version are marked prerelease. Publication starts as a draft until every asset has been
uploaded. An existing release is never overwritten; use a new version after a partial failed
publication or remove only the failed draft yourself. `--cask-only` repairs a failed cask PR
without rebuilding or replacing a checksummed DMG. Merge the generated cask PR to make the
new version available through the tap. PRs created with `GITHUB_TOKEN` don't automatically
trigger other Actions workflows; validate the cask during release and review its pinned URL/hash.

For a local signed release, first save a notarization profile using Apple's secure local
Keychain (`xcrun notarytool store-credentials fdrive-notary`), then run:

```sh
python3 tools/macos/release.py release \
  --version 0.1.0 --build 1 --team YOUR_TEAM_ID \
  --app-profile /path/to/app.provisionprofile \
  --extension-profile /path/to/extension.provisionprofile \
  --output .fdrive-workflow/release-0.1.0
```

Local signing uses an installed Developer ID identity and retains normal Keychain search
settings. Outputs are under the specified directory; install the DMG only after the helper
reports success. First-time Developer ID provisioning or restricted Apple capabilities may
require additional account setup; an unsigned archive does not verify that setup.

While Actions is disabled, publish a local build the same way: push the `macos-vX.Y.Z` tag
for the commit you built, then run the publisher on its artifacts and merge the cask PR:

```sh
python3 tools/macos/publish.py --repo fredrikburmester/fdrive-web \
  --artifacts .fdrive-workflow/release-0.1.0/artifacts
```

## Install or upgrade with Homebrew

After the first release and cask PR are merged, use the source repository as the tap. The
explicit URL is required because the repository isn't named `homebrew-fdrive-web`. Homebrew 7
refuses to load casks from untrusted third-party taps and aborts the tap, so trust it first.
A tap on a custom remote is trusted by that URL; trusting `fredrikburmester/fdrive-web` has no effect:

```sh
gh auth login
gh auth setup-git
brew trust --tap https://github.com/fredrikburmester/fdrive-web.git
brew tap fredrikburmester/fdrive-web https://github.com/fredrikburmester/fdrive-web.git
HOMEBREW_GITHUB_API_TOKEN="$(gh auth token)" brew install --cask fredrikburmester/fdrive-web/fdrive
```

The token must have read access to the private repository. It is supplied only to the install
process and the authenticated GitHub release-asset endpoint; no token appears in a saved
cask or URL. Avoid verbose Homebrew logging when using an authentication header.

Quit FDrive before upgrading:

```sh
brew update
HOMEBREW_GITHUB_API_TOKEN="$(gh auth token)" brew upgrade --cask fdrive
```

Once the repository is public, omit `gh auth` and the `HOMEBREW_GITHUB_API_TOKEN` prefix.
Homebrew then uses the ordinary GitHub release URL with the same pinned checksum. Disconnect
locations inside the app before uninstalling; the cask deliberately does not remove File
Provider databases or files under `~/Library/CloudStorage`.

Launch FDrive from Applications, enter `https://files.fdrive.se` (or your own fdrive HTTPS
web address), sign in and select storage identities. The server must include the desktop API from the native app change. No server
address or credentials are embedded in a distributable app.

References: [Apple Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
[notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
[GitHub signing](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications),
[Homebrew casks](https://docs.brew.sh/Cask-Cookbook).
