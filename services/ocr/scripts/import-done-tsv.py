#!/usr/bin/env python3
"""One-shot migration of filesai's OCR done-log (`$STATE/done.tsv`) into fdrive's
`idx.ocr_log`, so files filesai already OCR'd (or already knows have text, are
signed, or are encrypted) are not reprocessed by the first nightly pass here.

filesai's `done.tsv` lines look like:

    12345_1699999999|folder/report.pdf	ocr
    54321_1700000005|folder/scan.pdf	has_text

The key is `<size>_<mtime_seconds>|<path>`; `mtime_seconds` has only
second-precision, while `idx.ocr_log` keys on `mtime_ns`. This importer scales
seconds to nanoseconds (multiplying by 1e9), which usually matches exactly if
the file has not moved since (most filesystems that back SFTPGo report a whole
number of seconds when filesai's `stat -c '%s_%Y'` last ran). If a file's real
mtime carries sub-second precision, the imported key will not match on the
first pass, so that one file gets reprocessed once, which is safe: OCR is
idempotent and refuses PDFs that already have text.

Usage:
    python scripts/import-done-tsv.py done.tsv --root sftpgo \\
        --database-url "$DATABASE_URL"

Idempotent: rows are inserted `ON CONFLICT ... DO NOTHING` on the same unique
key the service itself uses, so running it twice is a no-op the second time.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

STATUS_MAP = {
    "ocr": "ocred",
    "has_text": "has_text",
    "signed": "signed",
    "encrypted": "encrypted",
}


@dataclass(frozen=True)
class DoneRow:
    path: str
    size: int
    mtime_ns: int
    status: str
    detail: str | None


def parse_line(line: str) -> DoneRow | None:
    """Parses one `done.tsv` line. Returns `None` for a blank line or one that
    does not match the expected `<size>_<mtime>|<path>\tstatus` shape, so the
    importer can skip odd lines rather than failing the whole batch."""
    line = line.rstrip("\n")
    if not line.strip():
        return None
    key, _, status_raw = line.partition("\t")
    if not status_raw:
        return None
    size_mtime, sep, path = key.partition("|")
    if not sep or not path:
        return None
    size_str, sep2, mtime_str = size_mtime.partition("_")
    if not sep2 or not size_str.isdigit() or not mtime_str.isdigit():
        return None
    size = int(size_str)
    mtime_ns = int(mtime_str) * 1_000_000_000
    status_raw = status_raw.strip()
    if status_raw.startswith("fail_rc"):
        return DoneRow(path=path, size=size, mtime_ns=mtime_ns, status="failed", detail=status_raw)
    status = STATUS_MAP.get(status_raw, status_raw)
    return DoneRow(path=path, size=size, mtime_ns=mtime_ns, status=status, detail=None)


def parse_lines(lines: list[str]) -> list[DoneRow]:
    rows = []
    for line in lines:
        row = parse_line(line)
        if row is not None:
            rows.append(row)
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tsv_path", help="path to filesai's done.tsv")
    parser.add_argument("--root", required=True, help="root name as configured in INDEX_ROOTS, e.g. sftpgo")
    parser.add_argument("--database-url", required=True, help="psycopg DSN for the fdrive database")
    args = parser.parse_args(argv)

    with open(args.tsv_path, encoding="utf-8") as fh:
        rows = parse_lines(fh.readlines())

    import psycopg

    with psycopg.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO "idx"."roots" (name) VALUES (%s) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name '
                "RETURNING id",
                (args.root,),
            )
            row = cur.fetchone()
            assert row is not None
            root_id = row[0]
            for r in rows:
                cur.execute(
                    """
                    INSERT INTO "idx"."ocr_log" (root_id, path, size, mtime_ns, status, detail, at)
                    VALUES (%s, %s, %s, %s, %s, %s, now())
                    ON CONFLICT (root_id, path, size, mtime_ns) DO NOTHING
                    """,
                    (root_id, r.path, r.size, r.mtime_ns, r.status, r.detail),
                )
        conn.commit()

    print(f"imported {len(rows)} rows into idx.ocr_log for root '{args.root}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
