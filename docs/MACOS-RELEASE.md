# Mac releases and Homebrew

The source repository also acts as the Homebrew tap, and the cask downloads the versioned DMG
from its public GitHub release. No second repository or access token is needed.

GitHub Actions is enabled. `tools/macos/cut-release.sh` below is the usual way to publish: it
builds and signs on this Mac, then pushes the tag and publishes. That tag also starts the
**macOS release** workflow, which skips the build when the tag is already published or when
its run number would not exceed the last published build number, because File Provider
refuses to upgrade to a lower build.

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
   python3 tools/macos/configure-ci.py --repo fredrikburmester/fdrive --team MWD5K362T8
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

## License seller

Releases are trialware: [MACOS.md](MACOS.md#trial-and-license) describes the behavior. Payments,
EU VAT and key delivery are handled by [Polar](https://polar.sh) as merchant of record.

1. Create the organization, then a one-time product with a **License keys** benefit. Set an
   activation limit (three Macs is a reasonable default) and no expiry.
2. Copy the organization ID (a UUID in the organization settings). It is public: the license
   endpoints need no secret, and none may ever be placed in the app or this repository.
3. Publish a product page with the download and the checkout link; that address is the
   purchase URL the app opens.

Every release must name both, or `release.py` refuses to build; it also verifies that the app
and the extension carry the same organization. For hosted builds set them as variables:

```sh
gh variable set MACOS_LICENSE_ORGANIZATION --repo fredrikburmester/fdrive --body ORGANIZATION_UUID
gh variable set MACOS_PURCHASE_URL --repo fredrikburmester/fdrive --body https://example.com/fdrive
```

Rehearse purchases in [Polar's sandbox](https://polar.sh/docs/integrate/sandbox), a separate
server with its own organizations and test cards. A development-signed build accepts its keys
when built with `FDRIVE_LICENSE_ORGANIZATION=SANDBOX_ORGANIZATION_UUID FDRIVE_LICENSE_SANDBOX=YES`
appended to the [development build command](MACOS.md#build-and-verify). Releases always clear
the sandbox setting, so a sandbox key can never unlock a published build.

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
`0.` version are marked prerelease, and no Mac release is marked Latest: that stays with the
server release, whose `compose.yaml` the install guide downloads through the latest-release
link. Publication starts as a draft until every asset has been uploaded. An existing release is
never overwritten; use a new version after a partial failed publication or remove only the
failed draft yourself. `--cask-only` repairs a failed cask PR without rebuilding or replacing a
checksummed DMG. Merge the generated cask PR to make the new version available through the tap.
PRs created with `GITHUB_TOKEN` don't automatically trigger other Actions workflows; validate
the cask during release and review its pinned URL/hash.

For a local signed release, first save a notarization profile using Apple's secure local
Keychain (`xcrun notarytool store-credentials fdrive-notary`), then run:

```sh
python3 tools/macos/release.py release \
  --version 0.1.0 --build 1 --team YOUR_TEAM_ID \
  --app-profile /path/to/app.provisionprofile \
  --extension-profile /path/to/extension.provisionprofile \
  --license-organization ORGANIZATION_UUID --purchase-url https://example.com/fdrive \
  --output .fdrive-workflow/release-0.1.0
```

Local signing uses an installed Developer ID identity and retains normal Keychain search
settings. Outputs are under the specified directory; install the DMG only after the helper
reports success. First-time Developer ID provisioning or restricted Apple capabilities may
require additional account setup; an unsigned archive does not verify that setup.

Publish a local build the same way: push the `macos-vX.Y.Z` tag for the commit you built,
then run the publisher on its artifacts and merge the cask PR:

```sh
python3 tools/macos/publish.py --repo fredrikburmester/fdrive \
  --artifacts .fdrive-workflow/release-0.1.0/artifacts
```

`tools/macos/cut-release.sh` runs those three steps as one command from a checkout of the
merged commit. It reads the team, license organization and purchase URL from the repository
variables, finds the two Developer ID profiles Xcode has installed by name, refuses a dirty
tree, a commit that is not on `main`, an existing tag or a build number at or below the last
published release's, and tags only after the signed build succeeded:

```sh
tools/macos/cut-release.sh 0.1.0 1            # add --dry-run to see the commands first
```

## Install or upgrade with Homebrew

Use the source repository as the tap. The explicit URL is required because the repository
isn't named `homebrew-fdrive`. Homebrew 7 refuses to load casks from untrusted third-party taps
and aborts the tap, so trust it first. A tap on a custom remote is trusted by that URL;
trusting `fredrikburmester/fdrive` has no effect:

```sh
brew trust --tap https://github.com/fredrikburmester/fdrive.git
brew tap fredrikburmester/fdrive https://github.com/fredrikburmester/fdrive.git
brew install --cask fredrikburmester/fdrive/fdrive
```

Quit FDrive before upgrading:

```sh
brew update
brew upgrade --cask fdrive
```

Homebrew downloads the ordinary GitHub release URL and checks the pinned checksum. Disconnect
locations inside the app before uninstalling; the cask deliberately does not remove File
Provider databases or files under `~/Library/CloudStorage`.

Launch FDrive from Applications, enter your fdrive HTTPS web address (for example
`https://drive.example.com`), sign in and select storage identities. The server must include the desktop API from the native app change. No server
address or credentials are embedded in a distributable app.

References: [Apple Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
[notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
[GitHub signing](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications),
[Homebrew casks](https://docs.brew.sh/Cask-Cookbook).
