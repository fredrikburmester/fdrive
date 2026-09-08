# Set up fdrive

fdrive starts as a lightweight file browser. On the first visit, the server
owner completes the setup walkthrough: claim the server, test the SFTPGo
connection, sign in as the owner, verify available storage, and choose optional
features. Search, thumbnails, OCR, semantic search, and image search are all
enabled there and later changed in **System > Features**. They never require a
Compose profile or a feature environment variable.

## Start the stack

```sh
git clone https://github.com/fredrikburmester/fdrive-web.git /path/to/fdrive
cd /path/to/fdrive/deploy
./init-env.sh
```

This creates `deploy/.env` with 0600 permissions and two secrets without
printing them. It refuses an existing file, so it never rotates the master key.
See [REFERENCE.md](REFERENCE.md) for advanced options.

Start it:

```sh
./update.sh
```

From another device on the same network, open `http://<server-ip>:8090`
(for example, `http://192.168.1.105:8090`). The default listens on the server’s
network interfaces; no bind-address or cookie changes are needed. Use the
one-time claim token printed in the API log. The
walkthrough tests an SFTPGo URL before saving it and establishes the
owner through a normal SFTPGo login. Leave `SFTPGO_URL` commented in `.env` to
do this in the browser.

## Optional features

The fixed stack includes small controllers for optional services. With every
feature off, it does no indexing, OCR, embedding, thumbnail processing, or
model download. Enabling a feature in the walkthrough starts only its needed
work; disabling it stops work and releases model memory while retaining cached
data until an explicit clear action.

| Feature | Walkthrough requirement |
| --- | --- |
| Thumbnails | Verified locally mounted storage |
| Full-text search | Verified storage and extraction worker |
| Searchable OCR | Full-text search; leaves source files unchanged |
| Semantic search | Full-text search; starts the text embedding model |
| Image search | Verified storage; generates internal previews and starts the SigLIP model |
| Searchable PDF conversion | Explicit choice and writable verified storage; rewrites PDFs |

The walkthrough distinguishes searchable OCR from PDF conversion. The former
indexes text without changing files. The latter writes searchable PDF layers
back to SFTPGo and keeps originals according to its retention setting.

## Storage and SFTPGo

Browsing works against any SFTPGo server reachable from the API. Optional
processing needs a host directory mounted into the bundled workers; a browser
cannot add arbitrary host paths to a running container. The walkthrough reports
when a selected SFTPGo path is remote or lacks a matching approved mount and
keeps browsing available. Add or change mounts using the [advanced
reference](REFERENCE.md), then restart the stack and return to System >
Features.

To use the bundled SFTPGo overlay, choose its deployment settings in the
advanced reference before starting it. The walkthrough then connects to
`http://sftpgo:8080` and handles the normal owner setup.

## Update

```sh
cd /path/to/fdrive/deploy && ./update.sh
```

See [REFERENCE.md](REFERENCE.md) for reverse proxies, host mounts, bundled
SFTPGo, Office, and ARM64.
