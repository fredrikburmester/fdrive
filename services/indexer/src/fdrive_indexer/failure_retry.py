"""Retry a fixed inventory of unresolved files, sharing maintenance admission."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from collections.abc import Sequence
from contextlib import nullcontext

from . import db, failures
from .diagnostic_log import log
from .indexer import RootContext, _process_file, embed_missing, process_image_embedding, process_thumbnails
from .paths import ext_of
from .thumb_rebuild import ThumbnailRebuildJob


def retry_file(ctx: RootContext, path: str, feature: str) -> tuple[bool, bool]:
    from .server import _open_extraction_file

    with failures.attempt() as observation:
        try:
            # embed_missing owns the path lock and checks the expected content
            # under that lock; nesting our non-reentrant lock would deadlock.
            lock = nullcontext() if feature == "semanticSearch" else ctx.path_locks.get(path)
            with lock, _open_extraction_file(ctx.abs_path, path) as (source, size):
                st = os.stat(source)
                with open(source, "rb") as stream:
                    sha = hashlib.file_digest(stream, "sha256").hexdigest()
                if feature == "semanticSearch":
                    ok = embed_missing(ctx, path, expected_sha=sha)
                    return observation.outcomes.get(feature, (ok, not ok))
                if feature == "textSearch":
                    _process_file(ctx, source, path, st, sha, only_feature="textSearch")
                else:
                    # Changed originals invalidate old text before a new derivative
                    # is published. Normal scans refill their text later.
                    if db.file_content_key(ctx.conn(), ctx.root_id, path) != sha:
                        db.upsert_file(ctx.conn(), ctx.root_id, path, os.path.basename(path), ext_of(path),
                                       size, st.st_mtime_ns, sha, None)
                    if feature == "thumbnails":
                        return process_thumbnails(ctx, source, path, ext_of(path), sha, size, force=True)
                    process_image_embedding(ctx, path, sha)
                return observation.outcomes.get(feature, (True, True))
        except Exception as exc:  # noqa: BLE001 - preserve failed files for the next retry
            reason = failures.describe(exc)
            log(f"retry {feature} {path}: {reason}")
            if observation.outcomes.get(feature, (True, False))[0]:
                failures.report(ctx, path, feature, log, reason)
            return False, False


def start_retry(job: ThumbnailRebuildJob, contexts: Sequence[RootContext], feature: str, failure_id: int | None) -> bool:
    if not job.try_start(0):
        return False
    job.revision = max((ctx.feature_configuration().revision for ctx in contexts), default=0)

    def run() -> None:
        try:
            by_name = {ctx.name: ctx for ctx in contexts}
            # Spool a fixed inventory to temporary disk rather than loading an
            # unbounded library into RAM or silently truncating a retry request.
            with tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+t", encoding="utf-8") as inventory:
                for ctx in contexts:
                    with ctx.conn().transaction(), ctx.conn().cursor(name="failure_inventory") as cur:
                        cur.execute(
                            'SELECT id, path FROM idx.processing_failures '
                            'WHERE root_id = %s AND feature = %s AND resolved_at IS NULL '
                            'AND (%s::bigint IS NULL OR id = %s) ORDER BY id',
                            (ctx.root_id, feature, failure_id, failure_id),
                        )
                        for issue_id, path in cur:
                            inventory.write(json.dumps([ctx.name, issue_id, path]) + "\n")
                            job.discover(1)
                job.discovered()
                inventory.seek(0)
                for line in inventory:
                    name, issue_id, path = json.loads(line)
                    ctx = by_name[name]
                    ctx.maybe_refresh_features()
                    if not ctx.feature_configuration().values.as_json()[feature]:
                        break
                    with ctx.conn().cursor() as cur:
                        cur.execute('SELECT 1 FROM idx.processing_failures WHERE id = %s AND resolved_at IS NULL', (issue_id,))
                        if cur.fetchone() is None:
                            job.advance(True, skipped=True)
                            continue
                    with failures.attempt({feature: job.run_id}):
                        ok, skipped = retry_file(ctx, path, feature)
                    job.advance(ok, skipped)
            for ctx in contexts:
                failures.prune(ctx.conn())
        except Exception as exc:  # noqa: BLE001
            job.fail()
            log(f"failure retry crashed: {failures.describe(exc)}")
        finally:
            job.finish()

    try:
        threading.Thread(target=run, daemon=True, name="failure-retry").start()
    except Exception:
        job.fail()
        job.finish()
        raise
    return True
