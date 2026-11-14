"""Pure decisions about whether an indexed PDF is worth attempting: fdrive's own
folders, exclude globs (matched with `fnmatch` against `<root>/<rel>`, same
convention as the indexer's `rules.py`) and the size cap.
"""

from __future__ import annotations

from fnmatch import fnmatch

BYTES_PER_MB = 1024 * 1024

#: fdrive's own folders, compared with each segment of an index path in any case
#: (`isReservedPath` in `@fdrive/core`): its Trash layout wherever the Trash folder is or
#: was, `.trash` (its default Trash folder), the Mac app's folder (staged uploads,
#: replaced versions and its Trash) and backup folders. A PDF in one of them is not
#: the user's live file, so it is never rewritten. The indexer never walks the last
#: two, but it does index the Trash.
RESERVED_FOLDERS: tuple[str, ...] = (".fdrive-move-v1", ".trash", ".fdrive-desktop", ".fdrive-backups")


def root_relative_key(root: str, rel_path: str) -> str:
    return f"{root}/{rel_path}"


def is_excluded(root: str, rel_path: str, globs: list[str], include_globs: list[str] | None = None) -> bool:
    """`include_globs`, when non-empty (`OCR_INCLUDE_GLOBS`), restricts candidates
    to paths matching at least one of them; this overrides `globs`'s default
    exclusion behaviour for anything outside that set, but `globs` (the
    exclude list, whether the built-in default or an operator override) is
    still applied on top, so a path can be included and then excluded again by
    a more specific exclude pattern."""
    key = root_relative_key(root, rel_path)
    if include_globs and not any(fnmatch(key, pattern) for pattern in include_globs):
        return True
    return any(fnmatch(key, pattern) for pattern in globs)


def is_too_big(size_bytes: int, max_mb: int) -> bool:
    return size_bytes > max_mb * BYTES_PER_MB
