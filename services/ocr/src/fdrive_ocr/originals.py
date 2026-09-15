"""Pure decisions about kept originals: identifier validation, sidecar parsing,
what state the live file at a kept original's source path is in, whether a
restore may proceed, and which kept originals a retention window has aged out.

All filesystem and database work lives in `restore.py`; this module only maps
already-fetched facts onto decisions, the same split `decide.py` and
`runner.py` use for the OCR pass itself.
"""

from __future__ import annotations

from dataclasses import dataclass

MAPPING_VERSION = 1
# `runner.originals_dest` names a kept file `<16 hex digits>_<basename>`, so an
# identifier is never longer than a filename, never a path, and never one of
# the `.original-`/`.mapping-` temporary files a partial keep leaves behind.
ID_MAX_LENGTH = 512

STATE_OCRED = "ocred"
STATE_RESTORED = "restored"
STATE_CHANGED = "changed"
STATE_MISSING = "missing"

REFUSAL_TARGET_MISSING = "target_missing"
REFUSAL_TARGET_CHANGED = "target_changed"

#: Status written to `idx.ocr_log` for a restored file's own `(size, mtime_ns)`
#: key. The done-log is presence-keyed, so this is what stops the next pass
#: from immediately OCR'ing the file straight back again.
STATUS_RESTORED = "restored"


def is_valid_id(value: str) -> bool:
    """Whether `value` can name a file directly inside `<state_dir>/originals`.

    Rejects anything with a path separator, a NUL, a leading dot (both the
    `.`/`..` entries and the temporary files a partial keep leaves behind), and
    anything implausibly long, so a caller-supplied identifier can never escape
    the originals directory or address a half-written copy.
    """
    if not value or len(value) > ID_MAX_LENGTH:
        return False
    if value.startswith("."):
        return False
    return not any(character in value for character in ("/", "\\", "\0"))


@dataclass(frozen=True)
class Mapping:
    """A kept original's source facts, from its `original-mappings` sidecar."""

    root: str
    path: str
    size: int
    mtime_ns: int
    original: str
    sha256: str | None
    legacy: bool
    kept_at_ns: int | None


def _as_int(value: object) -> int | None:
    """Sidecar integers are written as JSON strings for `mtime_ns` (which
    exceeds a double's exact range) and as numbers for `size`."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    return None


def parse_mapping(raw: object) -> Mapping | None:
    """Validates one decoded sidecar document. Unknown extra fields are kept
    tolerated so a newer service can add to the format without stranding an
    older reader; anything missing or malformed resolves to `None`, which the
    caller reports as unresolved rather than guessing a source path."""
    if not isinstance(raw, dict) or raw.get("version") != MAPPING_VERSION:
        return None
    root, path, original = raw.get("root"), raw.get("path"), raw.get("original")
    if not isinstance(root, str) or not root or not isinstance(path, str) or not path:
        return None
    if not isinstance(original, str) or not is_valid_id(original):
        return None
    size, mtime_ns = _as_int(raw.get("size")), _as_int(raw.get("mtime_ns"))
    if size is None or mtime_ns is None:
        return None
    digest = raw.get("sha256")
    return Mapping(
        root=root,
        path=path,
        size=size,
        mtime_ns=mtime_ns,
        original=original,
        sha256=digest if isinstance(digest, str) and digest else None,
        legacy=raw.get("legacy") is True,
        kept_at_ns=_as_int(raw.get("kept_at_ns")),
    )


def mapping_document(mapping: Mapping) -> dict[str, object]:
    """The sidecar document for `mapping`, as written next to a kept original."""
    document: dict[str, object] = {
        "version": MAPPING_VERSION,
        "root": mapping.root,
        "path": mapping.path,
        "size": mapping.size,
        "mtime_ns": str(mapping.mtime_ns),
        "original": mapping.original,
        "sha256": mapping.sha256,
    }
    if mapping.kept_at_ns is not None:
        document["kept_at_ns"] = str(mapping.kept_at_ns)
    if mapping.legacy:
        document["legacy"] = True
    return document


@dataclass(frozen=True)
class TargetStat:
    size: int
    mtime_ns: int


def classify_state(
    target: TargetStat | None,
    original_size: int,
    original_mtime_ns: int,
    ocred_keys: frozenset[tuple[int, int]],
) -> str:
    """What the live file at a kept original's source path currently is.

    `ocred_keys` are the `(size, mtime_ns)` pairs `idx.ocr_log` recorded as
    `ocred` for that exact path. A rewrite preserves the source's mtime and only
    changes its size, so these three cases do not overlap in practice:

    - the live bytes already look like the kept original: `restored`
    - they match a recorded OCR result for the path: `ocred`, the ordinary case
    - anything else: `changed`, edited or replaced since OCR ran
    """
    if target is None:
        return STATE_MISSING
    if (target.size, target.mtime_ns) == (original_size, original_mtime_ns):
        return STATE_RESTORED
    if (target.size, target.mtime_ns) in ocred_keys:
        return STATE_OCRED
    return STATE_CHANGED


def restore_refusal(state: str, allow_recreate: bool, allow_overwrite_changed: bool) -> str | None:
    """The reason a restore in `state` must not proceed, or `None` to go ahead.

    Restoring over the OCR output is the expected case and needs no opt-in.
    Recreating a file that is no longer there, and overwriting one that changed
    after OCR ran, each destroy something the kept original cannot describe, so
    both require the caller to have seen the state and said so explicitly.
    """
    if state == STATE_MISSING and not allow_recreate:
        return REFUSAL_TARGET_MISSING
    if state == STATE_CHANGED and not allow_overwrite_changed:
        return REFUSAL_TARGET_CHANGED
    return None


def retention_cutoff(now_seconds: float, retention_days: int) -> float | None:
    """The kept-at time before which originals have aged out, or `None` when
    retention is off. Zero (the default) and any negative value keep forever, so
    an existing installation never loses bytes by upgrading into this setting."""
    if retention_days <= 0:
        return None
    return now_seconds - retention_days * 86400.0


def matches_query(mapping: Mapping | None, original_id: str, query: str) -> bool:
    """Case-insensitive substring match over a kept original's source path, used
    for the admin listing's search box. An unresolved original can still be
    found by the filename embedded in its identifier."""
    needle = query.strip().lower()
    if not needle:
        return True
    haystack = original_id.lower() if mapping is None else f"{mapping.root}/{mapping.path}".lower()
    return needle in haystack
