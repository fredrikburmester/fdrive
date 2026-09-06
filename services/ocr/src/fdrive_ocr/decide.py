"""Pure mapping from `ocrmypdf`'s exit code and stderr text to the status this
service records, mirroring filesai's `run.sh` exit-code handling exactly:

- exit 0: OCR applied, the output file replaces the original.
- exit 6, or `TaggedPDFError` in stderr (an office-generated PDF ocrmypdf's exit
  code alone does not always catch): the PDF already has text, left untouched.
- `DigitalSignatureError` / `EncryptedPdfError` in stderr: signed or encrypted,
  refused, left untouched.
- anything else: a failure, with a short detail for the log.

No `--skip-text` / `--force-ocr` is ever passed, so a PDF that already has a
text layer is never rewritten; ocrmypdf itself is the source of truth for that.
"""

from __future__ import annotations

from dataclasses import dataclass

STATUS_OCRED = "ocred"
STATUS_HAS_TEXT = "has_text"
STATUS_SIGNED = "signed"
STATUS_ENCRYPTED = "encrypted"
STATUS_TOO_BIG = "too_big"
STATUS_EXCLUDED = "excluded"
STATUS_TIMEOUT = "timeout"
STATUS_FAILED = "failed"

_DETAIL_LINES = 3


@dataclass(frozen=True)
class Decision:
    status: str
    detail: str | None
    rewrite: bool


def decide(exit_code: int, stderr: str, timed_out: bool = False) -> Decision:
    if timed_out:
        return Decision(STATUS_TIMEOUT, "ocrmypdf timed out", rewrite=False)
    if exit_code == 0:
        return Decision(STATUS_OCRED, None, rewrite=True)
    if exit_code == 6:
        return Decision(STATUS_HAS_TEXT, None, rewrite=False)
    if "TaggedPDFError" in stderr:
        return Decision(STATUS_HAS_TEXT, None, rewrite=False)
    if "DigitalSignatureError" in stderr:
        return Decision(STATUS_SIGNED, None, rewrite=False)
    if "EncryptedPdfError" in stderr:
        return Decision(STATUS_ENCRYPTED, None, rewrite=False)
    tail = "\n".join(stderr.strip().splitlines()[-_DETAIL_LINES:])
    detail = tail if tail else f"exit code {exit_code}"
    return Decision(STATUS_FAILED, detail, rewrite=False)
