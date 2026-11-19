"""Pure decisions about whether an indexed PDF is worth attempting: fdrive's own
folders, encrypted names, exclude globs (matched with `fnmatch` against
`<root>/<rel>`, same convention as the indexer's `rules.py`) and the size cap.
"""

from __future__ import annotations

import re
from fnmatch import fnmatch

BYTES_PER_MB = 1024 * 1024

#: The file at the top of an end-to-end encrypted folder (`ENCRYPTED_FOLDER_MARKER` in
#: `@fdrive/contracts`). Everything below it is the owner's ciphertext, or a file someone put
#: there from outside fdrive, and is never OCR'd.
ENCRYPTED_FOLDER_MARKER = ".fdrive-encrypted"

#: What every encrypted name starts with: the format's version.
ENCRYPTED_NAME_PREFIX = "fe1-"

#: An encrypted name: the prefix, then lowercase unpadded base32 for at least one byte of name
#: and at most 128 (`isEncryptedName` in `@fdrive/contracts`).
_ENCRYPTED_NAME = re.compile(re.escape(ENCRYPTED_NAME_PREFIX) + r"[a-z2-7]{47,250}")

#: Valid base32 lengths leave fewer than five spare bits.
_BASE32_LENGTH_REMAINDERS = frozenset({0, 2, 4, 5, 7})

#: fdrive's own folders, compared with each segment of an index path in any case
#: (`isReservedPath` in `@fdrive/core`): `.trash` (its Trash) and the Mac app's folder
#: (its staged uploads). A PDF in one of them is not the user's live file, so it is never
#: rewritten. The indexer never walks the last, but it does index the Trash.
RESERVED_FOLDERS: tuple[str, ...] = (".trash", ".fdrive-desktop")


def root_relative_key(root: str, rel_path: str) -> str:
    return f"{root}/{rel_path}"


def is_encrypted_name(name: str) -> bool:
    """Whether a stored name has the shape of an encrypted name. Only a client can tell
    whether it decrypts."""
    body = len(name) - len(ENCRYPTED_NAME_PREFIX)
    return _ENCRYPTED_NAME.fullmatch(name) is not None and body % 8 in _BASE32_LENGTH_REMAINDERS


def has_encrypted_part(rel_path: str) -> bool:
    """Whether a part of `rel_path` is an encrypted name, so it lies inside an encrypted
    folder: an item put in Trash on its own keeps its encrypted name, with no marker above it."""
    return any(is_encrypted_name(part) for part in rel_path.split("/"))


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
