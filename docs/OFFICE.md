# Office documents and editing

ONLYOFFICE is bundled with the standard fdrive stack. Enable it during onboarding,
or later in **System > Features > ONLYOFFICE**. No additional Compose file,
activation environment variable, or processing storage mount is needed.

## Enable the editor

1. Turn on **Enable ONLYOFFICE**.
2. Check **fdrive browser address**. It is filled from your current browser address;
   use the HTTP(S) origin everyone uses to reach fdrive, including any port.
3. Leave editing off for viewing only, or enable **Allow document editing** and enter
   the SFTPGo usernames allowed to edit, one per line.
4. Save. The bundled Document Server starts automatically. You may finish onboarding
   while it starts; System settings show its readiness.

Open a Word, Excel, PowerPoint, or OpenDocument file from fdrive. Files remain in
SFTPGo; fdrive transfers document contents through WOPI. Search and OCR are independent.

The container keeps a small controller running when disabled. The document engine
starts only when enabled and uses additional memory. Secrets are generated automatically;
its volume preserves proof keys across restarts. Close open documents before disabling
ONLYOFFICE so that unsaved work is not interrupted.

## Editing permissions

Editing defaults off. The allowed-user list belongs to the configured SFTPGo provider;
changing providers does not grant editing to matching usernames on the new server.
These are ordinary SFTPGo file users, not SFTPGo administrators.

Only add users who should participate in editing sessions. A shared editing session can
save one participant's changes through another participant, so upload permissions alone
are insufficient to decide who may enter it. fdrive checks the explicit editor list
when opening documents and handling callbacks; SFTPGo still enforces the saving user's
file permissions. Advanced path-specific admission rules can further restrict access.

## Connection requirements and diagnosis

The browser reaches the editor through `/onlyoffice` on the same fdrive address.
The standard private Docker network connects fdrive's API and Document Server; callbacks
use the internal API address. An external reverse proxy must forward WebSockets and
preserve the `/onlyoffice` path. See the [deployment reference](../deploy/REFERENCE.md).

- **Starting:** allow startup time and check the ONLYOFFICE container's logs.
- **Unavailable:** check the container, its connection to the API, and discovery endpoint.
- **Editor fails to load:** verify the saved browser address and reverse proxy forwarding.
- **Viewing works but editing is unavailable:** check the editing toggle and exact SFTPGo
  username in the allowed-user list.

Do not reset the database or delete volumes to troubleshoot an editor connection.

## Alternate document server

Collabora remains an advanced deployment option through `compose.office.collabora.yaml`.
Configure these deployment inputs for a dedicated HTTPS Collabora hostname:

```dotenv
FDRIVE_COMPOSE_FILES="compose.office.collabora.yaml"
FDRIVE_PROFILES="collabora"
FDRIVE_COLLABORA_HOST=office.example.com
```

Route that hostname to the fdrive proxy, then run `./update.sh`. Enable and configure
Office through the same System settings. The advanced overlay supplies its network
endpoints and browser CSP origin. Environment variables do not activate
Office. The standard bundled ONLYOFFICE engine stays idle when Collabora is selected.

## Architecture and verification

fdrive is the WOPI host. It verifies signed Document Server callbacks using discovery
proof keys, binds sessions to identities and providers, and coordinates locks in Postgres.
Saves return to SFTPGo. Real editor tests verify saved document bytes and read-only
admission; see [Office tests](OFFICE-TESTS.md).
