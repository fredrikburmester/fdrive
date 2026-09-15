# AI chat with files

A proposed follow-up to [AI organize](../AI.md). Not started.

## Outcome

A person opens a chat panel from the file browser, asks questions about their files ("which
invoices from 2024 are unpaid?", "summarize this folder") and gets answers that link to the
files used. The chat can offer the same reviewed moves as Organize, never silent writes.

## Current behavior

AI exists only as the one-shot organize run. `AiModel` conversations live in memory for one
run, and the organizer's tools are read-only and limited to the selection for content.

## Proposal

- Reuse `AiModel` and the organize tools, adding a scoped `read_excerpts` over any readable
  indexed file and a file-link citation format the UI can render.
- Stream turns to the browser (SSE) instead of polling. Store a conversation's native history
  server-side per identity with a retention limit, and compact or clear old tool results for
  long chats.
- Keep writes as proposals rendered with the organize review, applied through `fs/move-many`.
- Decide whether chats persist across restarts and who can see an administrator's usage.

## Complete when

- Answers cite only files the login can read, verified with cross-identity isolation tests.
- Cancelling, reconnecting and a failed provider turn behave predictably in browser checks.
- The data notice on System > AI describes what chat sends.
