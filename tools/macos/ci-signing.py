#!/usr/bin/env python3
"""Install only this job's signing material; secrets never enter build logs."""

import base64
import os
from pathlib import Path
import secrets
import subprocess
import sys


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        sys.exit("This helper only runs on disposable GitHub-hosted runners")
    required = ("MACOS_CERTIFICATE_BASE64", "MACOS_CERTIFICATE_PASSWORD",
                "MACOS_NOTARY_KEY_BASE64", "MACOS_NOTARY_KEY_ID", "MACOS_NOTARY_ISSUER_ID",
                "MACOS_APP_PROFILE_BASE64", "MACOS_EXTENSION_PROFILE_BASE64")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        sys.exit("Missing release configuration: " + ", ".join(missing))
    root = Path(os.environ["RUNNER_TEMP"]) / "fdrive-signing"
    root.mkdir(mode=0o700)
    certificate = root / "certificate.p12"
    api_key = root / "notary.p8"
    keychain = root / "signing.keychain-db"
    password = secrets.token_urlsafe(32)
    certificate.write_bytes(base64.b64decode(os.environ["MACOS_CERTIFICATE_BASE64"], validate=True))
    certificate.chmod(0o600)
    api_key.write_bytes(base64.b64decode(os.environ["MACOS_NOTARY_KEY_BASE64"], validate=True))
    api_key.chmod(0o600)
    for kind in ("app", "extension"):
        profile = root / f"{kind}.provisionprofile"
        profile.write_bytes(base64.b64decode(os.environ[f"MACOS_{kind.upper()}_PROFILE_BASE64"], validate=True))
        profile.chmod(0o600)

    def run(*args):
        # Apple's tools can print keychain metadata; never forward it to Actions logs.
        result = subprocess.run(args, capture_output=True)
        if result.returncode:
            sys.exit(f"Signing setup failed at {args[0]} {args[1]}; check certificate/notary credentials")

    run("security", "create-keychain", "-p", password, str(keychain))
    run("security", "set-keychain-settings", "-lut", "21600", str(keychain))
    run("security", "unlock-keychain", "-p", password, str(keychain))
    run("security", "import", str(certificate), "-k", str(keychain),
        "-P", os.environ["MACOS_CERTIFICATE_PASSWORD"], "-T", "/usr/bin/codesign",
        "-T", "/usr/bin/security")
    run("security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s",
        "-k", password, str(keychain))
    # This runs only on disposable GitHub-hosted runners, never on a user's login keychain.
    run("security", "list-keychains", "-d", "user", "-s", str(keychain))
    run("xcrun", "notarytool", "store-credentials", "fdrive-notary", "--keychain", str(keychain),
        "--key", str(api_key), "--key-id", os.environ["MACOS_NOTARY_KEY_ID"],
        "--issuer", os.environ["MACOS_NOTARY_ISSUER_ID"])
    certificate.unlink()
    api_key.unlink()
    with open(os.environ["GITHUB_ENV"], "a") as file:
        file.write(f"FDRIVE_SIGNING_KEYCHAIN={keychain}\n")
    print("Developer ID signing and notarization credentials installed and validated.")


if __name__ == "__main__":
    main()
