import hashlib
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from publish import read_manifest, release_notes, render_cask, repository_value
from release import APP_ID, license_settings, notarize, validate_entitlements, version_value
from profiles import validate_profile


class ReleaseSafetyTests(unittest.TestCase):
    def test_profile_cannot_authorize_another_team_app_or_certificate(self):
        profile = {
            "TeamIdentifier": ["ABCDEFGHIJ"],
            "UUID": "9ee054b0-a74f-48aa-a7f8-a75c8589f9b2",
            "Entitlements": {"com.apple.application-identifier": f"ABCDEFGHIJ.{APP_ID}"},
            "ProvisionsAllDevices": True,
            "ExpirationDate": datetime.now(timezone.utc) + timedelta(days=1),
            "DeveloperCertificates": [b"test certificate"],
        }
        digest = hashlib.sha1(b"test certificate").hexdigest()
        self.assertEqual(validate_profile(profile, "ABCDEFGHIJ", APP_ID, digest), profile["UUID"])
        for team, app, certificate in (("OTHERTEAM1", APP_ID, digest),
                                        ("ABCDEFGHIJ", "other.app", digest),
                                        ("ABCDEFGHIJ", APP_ID, "0" * 40)):
            with self.subTest(team=team, app=app), self.assertRaises(ValueError):
                validate_profile(profile, team, app, certificate)
        with self.assertRaises(ValueError):
            validate_profile({**profile, "ExpirationDate": datetime(2000, 1, 1)}, "ABCDEFGHIJ", APP_ID)
        for entitlement in ("get-task-allow", "com.apple.security.get-task-allow"):
            with self.subTest(entitlement=entitlement), self.assertRaises(ValueError):
                validate_profile({**profile, "Entitlements": {**profile["Entitlements"], entitlement: True}},
                                 "ABCDEFGHIJ", APP_ID)

    def test_versions_and_repository_names_cannot_inject_shell_or_ruby(self):
        for value in ("../1.2.3", "1.2.3\n", "1.2.3;id", "1.2", "01.2.3"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                version_value(value)
        for value in ("owner/repo/extra", 'owner/repo"', "owner/repo\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                repository_value(value)
        self.assertEqual(version_value("0.1.0"), "0.1.0")

    def test_release_cannot_ship_without_a_seller_or_with_injected_settings(self):
        organization = "0b8f4a52-6f0e-4a63-9f2b-2f3b1f6f7a11"
        self.assertEqual(license_settings(organization, "https://fdrive.se/mac"), {
            "FdriveLicenseOrganization": organization, "FdrivePurchaseURL": "https://fdrive.se/mac",
            "FdriveLicenseSandbox": ""})
        for bad in (None, "", organization.upper(), organization + "\n", "not-a-uuid"):
            with self.subTest(organization=bad), self.assertRaises(ValueError):
                license_settings(bad, "https://fdrive.se/mac")
        for bad in (None, "", "http://fdrive.se", "https://fdrive.se/$(HOME)", "https://fdrive.se/a b", "https://fdrive.se\n"):
            with self.subTest(url=bad), self.assertRaises(ValueError):
                license_settings(organization, bad)

    def test_rejects_wrong_team_or_debugger_entitlements(self):
        team = "ABCDEFGHIJ"
        expected = {
            "com.apple.security.app-sandbox": True,
            "com.apple.security.network.client": True,
            "com.apple.security.application-groups": [f"{team}.{APP_ID}"],
            "keychain-access-groups": [f"{team}.{APP_ID}.shared"],
        }
        validate_entitlements(expected, team)
        with self.assertRaises(ValueError):
            validate_entitlements(expected, "OTHERTEAM1")
        with self.assertRaises(ValueError):
            validate_entitlements({**expected, "com.apple.security.get-task-allow": True}, team)

    def test_publication_rejects_modified_or_unnotarized_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            filename = "fdrive-0.1.0-arm64.dmg"
            digest = hashlib.sha256(b"test artifact").hexdigest()
            manifest = {"version": "0.1.0", "filename": filename, "sha256": digest, "notarized": True}
            (root / filename).write_bytes(b"test artifact")
            (root / "SHA256SUMS").write_text(f"{digest}  {filename}\n")
            (root / "release.json").write_text(json.dumps(manifest))
            self.assertEqual(read_manifest(root), manifest)
            (root / filename).write_bytes(b"modified artifact")
            with self.assertRaises(ValueError):
                read_manifest(root)
            (root / filename).write_bytes(b"test artifact")
            for changes in ({"notarized": False}, {"filename": "../../secret"}):
                (root / "release.json").write_text(json.dumps({**manifest, **changes}))
                with self.assertRaises(ValueError):
                    read_manifest(root)

    def test_apple_rejection_stops_the_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch("release.run", return_value=b'{"status":"Invalid"}'):
                with self.assertRaises(ValueError):
                    notarize(root / "app.zip", "profile", None, root / "notary.json")
            with patch("release.run", return_value=b'{"status":"Accepted"}'):
                notarize(root / "app.zip", "profile", None, root / "notary.json")

    def test_cask_downloads_the_public_release_without_credentials(self):
        cask = render_cask("owner/repo", "0.1.0", "a" * 64)
        self.assertIn('url "https://github.com/owner/repo/releases/download/macos-v#{version}/'
                      'fdrive-#{version}-arm64.dmg"', cask)
        self.assertNotIn("api.github.com", cask)
        self.assertNotIn("HOMEBREW_GITHUB_API_TOKEN", cask)
        self.assertIn("depends_on macos: :tahoe", cask)
        for digest in ("A" * 64, "a" * 63, "a" * 64 + '"'):
            with self.subTest(digest=digest), self.assertRaises(ValueError):
                render_cask("owner/repo", "0.1.0", digest)
        result = subprocess.run(["ruby", "-c"], input=cask.encode(), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_release_notes_describe_saves_and_the_trial(self):
        notes = release_notes("0.4.1")
        self.assertTrue(notes.startswith("FDrive for Mac 0.4.1, an early release."))
        self.assertIn("locations you allow as read and write accept saves", notes)
        self.assertIn("Free to try for 7 days, then a one-time license.", notes)
        self.assertNotIn("read-only", notes)
        with self.assertRaises(ValueError):
            release_notes("0.4.1\n")


if __name__ == "__main__":
    unittest.main()
