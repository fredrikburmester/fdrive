# fdrive-indexer

See [`docs/INDEXER.md`](../../docs/INDEXER.md) for what this service does, its configuration,
its internal HTTP API and how it is tested.

```sh
cargo test                       # needs Docker for the Postgres tests
scripts/test-in-docker.sh        # everything, including the Linux-only watcher tests
```
