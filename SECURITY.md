# Security policy

fdrive handles logins, storage credentials and public share links, so security reports are
welcome and taken seriously.

## Reporting a vulnerability

Report privately through
[GitHub's vulnerability reporting](https://github.com/fredrikburmester/fdrive-web/security/advisories/new).
Please do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can of:

- the affected part (web, API, a Python service, the Mac app, the deployment files) and version
  or commit,
- steps to reproduce, or a proof of concept,
- what an attacker gains, and which login or token they need to start with.

fdrive is maintained by one person. Expect an acknowledgement within about a week, and a fix or
a clear decision after that. You are credited in the advisory unless you prefer otherwise.

## Supported versions

Fixes land on `main` and in the latest FDrive for Mac release. Older commits and releases are
not patched; update to receive a fix.

## Scope

In scope: everything in this repository, including the Docker Compose deployment under
[`deploy/`](deploy/README.md) when it is set up as documented.

Out of scope:

- SFTPGo, ONLYOFFICE, Collabora, Caddy and other upstream software. Report those to their own
  projects. A way fdrive misuses them is in scope.
- Findings that need an already compromised server, administrator login or setup token.
- Deployments that ignore the documented setup, such as serving fdrive to the internet over
  plain HTTP. See [authentication](docs/AUTH.md) and the
  [deployment reference](deploy/REFERENCE.md).
- Denial of service by volume, and reports from automated scanners without a demonstrated
  impact.

Two behaviors are deliberate. The administrator connection probe may reach private network
addresses, because SFTPGo normally lives on one. Session cookies are not marked `Secure` on a
plain HTTP LAN deployment, and are once fdrive runs behind HTTPS.

## Testing

Test against your own installation. Do not test against servers or accounts that are not yours,
and do not access, change or delete other people's data.
