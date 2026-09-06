# fdrive-indexer

See [`docs/INDEXER.md`](../../docs/INDEXER.md) at the repository root for what
this service does, its configuration, its internal HTTP API, and how to test it.

Quick local setup:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

Full suite including the Linux-only inotify tests, from any host:

```sh
scripts/test-in-docker.sh
```
