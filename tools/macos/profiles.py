"""Validate and install profiles for this app's two identifiers, never another team."""

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import plistlib
import subprocess
import uuid


def validate_profile(profile, team, identifier, certificate_sha1=None):
    entitlements = profile.get("Entitlements", {})
    if profile.get("TeamIdentifier") != [team]:
        raise ValueError("Provisioning profile belongs to another Apple team")
    if entitlements.get("com.apple.application-identifier") != f"{team}.{identifier}":
        raise ValueError("Provisioning profile belongs to another app identifier")
    if (profile.get("ProvisionsAllDevices") is not True or entitlements.get("get-task-allow")
            or entitlements.get("com.apple.security.get-task-allow")):
        raise ValueError("Expected a Developer ID distribution profile")
    expires = profile.get("ExpirationDate")
    if not isinstance(expires, datetime) or expires.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise ValueError("Provisioning profile expired")
    if certificate_sha1 and certificate_sha1.upper() not in {
        hashlib.sha1(cert).hexdigest().upper() for cert in profile.get("DeveloperCertificates", [])
    }:
        raise ValueError("Profile does not authorize the selected signing certificate")
    profile_id = profile["UUID"]
    uuid.UUID(profile_id)
    # Xcode matches the profile specifier case-sensitively; preserve Apple's UUID.
    return profile_id


def install_profile(path, team, identifier, certificate_sha1=None):
    result = subprocess.run(["security", "cms", "-D", "-i", str(path)], check=True, capture_output=True)
    profile = plistlib.loads(result.stdout)
    profile_id = validate_profile(profile, team, identifier, certificate_sha1)
    destination = Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
    destination.mkdir(parents=True, exist_ok=True)
    installed = destination / f"{profile_id}.provisionprofile"
    installed.write_bytes(path.read_bytes())
    return profile_id
