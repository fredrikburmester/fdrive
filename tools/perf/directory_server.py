"""Use the real internal server and configured contexts without background indexing."""
import os

import uvicorn
from fdrive_indexer import db
from fdrive_indexer.config import Config
from fdrive_indexer.main import build_context
from fdrive_indexer.server import ServerState, create_app

cfg = Config()
connection = db.connect(cfg.database_url)
contexts = {name: build_context(cfg, cfg.database_url, name, path) for name, path in cfg.roots.items()}
state = ServerState(contexts, {}, {}, lambda: connection, lambda: db.read_schema_version(connection))
uvicorn.run(create_app(state), host="0.0.0.0", port=int(os.environ.get("INDEXER_PORT", "8010")), log_level="error")
