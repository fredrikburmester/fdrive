#!/usr/bin/env python3
"""Prompt locally for Apple credentials and upload them directly to GitHub Secrets."""

import argparse
import base64
import getpass
import hashlib
from pathlib import Path
import re
import plistlib
import subprocess
import sys
import uuid

from publish import repository_value
from profiles import validate_profile
from release import APP_ID, EXTENSION_ID


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--team", required=True)
    parser.add_argument("--certificate", type=Path)
    parser.add_argument("--certificate-password-file", type=Path)
    parser.add_argument("--api-key", type=Path)
    parser.add_argument("--key-id")
    parser.add_argument("--issuer")
    parser.add_argument("--app-profile", type=Path)
    parser.add_argument("--extension-profile", type=Path)
    args = parser.parse_args()
    repository_value(args.repo)
    if not re.fullmatch(r"[A-Z0-9]{10}", args.team):
        parser.error("Team ID must have ten uppercase letters/numbers")
    subprocess.run(["gh", "repo", "view", args.repo, "--json", "nameWithOwner"], check=True)
    print(f"Configuring {args.repo}: one Developer ID certificate/private key and Apple notarization credentials.")
    print("Passwords stay hidden. Values go directly to GitHub Secrets, never into source files.")
    certificate_path = (args.certificate or Path(input("Exported Developer ID Application .p12 path: ").strip())).expanduser()
    if certificate_path.suffix != ".p12" or not certificate_path.is_file():
        sys.exit("Provide the .p12 exported for the Developer ID Application certificate")
    certificate_password = (args.certificate_password_file.read_text().rstrip("\n")
                            if args.certificate_password_file else getpass.getpass(".p12 export password: "))
    api_key = (args.api_key or Path(input("App Store Connect team API key .p8 path: ").strip())).expanduser()
    key_id = args.key_id or input("API Key ID: ").strip()
    issuer = args.issuer or input("Issuer ID: ").strip()
    if not certificate_password or not api_key.is_file() or api_key.suffix != ".p8":
        sys.exit("A .p12 password and existing .p8 private key are required")
    if not re.fullmatch(r"[A-Z0-9]{10,}", key_id):
        sys.exit("Invalid API key ID")
    issuer = str(uuid.UUID(issuer))
    # Verify the certificate type and team without exporting or printing its private key.
    pem = subprocess.run(["openssl", "pkcs12", "-in", str(certificate_path), "-clcerts", "-nokeys",
                          "-passin", "stdin"], input=(certificate_password + "\n").encode(),
                         capture_output=True)
    if pem.returncode:
        sys.exit("Cannot read the .p12. Check its password and export format.")
    detail = subprocess.run(["openssl", "x509", "-noout", "-subject", "-text"], input=pem.stdout,
                            capture_output=True, check=True).stdout.decode()
    if "Developer ID Application:" not in detail or args.team not in detail:
        sys.exit("This is not a Developer ID Application certificate for the selected team")
    if pem.stdout.count(b"-----BEGIN CERTIFICATE-----") != 1:
        sys.exit("Export only one Developer ID Application identity into the .p12")
    certificate_der = subprocess.run(["openssl", "x509", "-outform", "DER"], input=pem.stdout,
                                     capture_output=True, check=True).stdout
    app_profile = (args.app_profile or Path(input("App Developer ID .provisionprofile path: ").strip())).expanduser()
    extension_profile = (args.extension_profile or Path(input("Extension Developer ID .provisionprofile path: ").strip())).expanduser()
    for path, identifier in ((app_profile, APP_ID), (extension_profile, EXTENSION_ID)):
        decoded = subprocess.run(["security", "cms", "-D", "-i", str(path)], check=True,
                                 capture_output=True).stdout
        validate_profile(plistlib.loads(decoded), args.team, identifier,
                         hashlib.sha1(certificate_der).hexdigest())
    for name, value in {"MACOS_TEAM_ID": args.team, "MACOS_NOTARY_KEY_ID": key_id,
                        "MACOS_NOTARY_ISSUER_ID": issuer}.items():
        subprocess.run(["gh", "variable", "set", name, "--repo", args.repo, "--body", value], check=True)
    values = {
        "MACOS_CERTIFICATE_BASE64": base64.b64encode(certificate_path.read_bytes()),
        "MACOS_CERTIFICATE_PASSWORD": certificate_password.encode(),
        "MACOS_NOTARY_KEY_BASE64": base64.b64encode(api_key.read_bytes()),
        "MACOS_APP_PROFILE_BASE64": base64.b64encode(app_profile.read_bytes()),
        "MACOS_EXTENSION_PROFILE_BASE64": base64.b64encode(extension_profile.read_bytes()),
    }
    for name, value in values.items():
        subprocess.run(["gh", "secret", "set", name, "--repo", args.repo], input=value, check=True)
        print(f"Configured {name}")
    print("Signing secrets configured. Dispatch macOS release to validate them without publishing.")


if __name__ == "__main__":
    main()
