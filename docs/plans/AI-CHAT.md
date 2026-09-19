# AI chat with files and folders

A follow-up to [AI organize](../AI.md). Planned; not started.

## Outcome

A chat panel docked beside the file browser stays open while the person moves between
folders and pages. They pull files and folders into it (drag from any listing, or **Add to
chat** from a selection) to reference them, and chat with an assistant that can look at those
references and act on them through tools:

- "What are these files about?" reads the referenced items and answers with links to them.
- "Is this a duplicate of another file?" reports exact copies (same content hash) and near
  copies (similar indexed content) elsewhere in the drive, with where they live.
- "Can I remove these files?" answers with evidence (copies elsewhere, age, size, what else
  references the name) and offers to move them to Trash.
- "Move these to a recommended folder" proposes destinations the way Organize does, with the
  same review, apply and undo.
- "Rewrite this file in a more professional way" reads the text, drafts the rewrite, and
  offers to save it as a new file next to the original or replace the original.

Nothing moves, is trashed or is written until the person approves that specific action in the
chat. Approval is per action card, shows exactly what will happen, and its outcome goes back to
the assistant as the tool result, so it can confirm or adjust.

A chat survives a reload and an API restart: the person comes back to the same transcript and
references. Recent chats are listed in the panel; the person can switch, rename and delete
them.

## Current behavior

AI is the one-shot Organize run only (`apps/api/src/ai/organize/`). `AiModel` returns whole
turns, tools are read-only and scoped to the selection, `read_excerpts` reads at most 1,500
characters of index text, runs are in memory for one identity and are polled. The Organize
session lives in a zustand store and its sheet is mounted inside the file browser, so it is
tied to the files page. The MCP server already has the primitives chat needs
(`runReadFileText`, `runFindDuplicates`, `runSimilarFiles`, `runMovePath`, `trashPath`,
`editFile`) but each assumes an MCP token principal for its write gates. Listings already
drag paths as `application/x-fdrive-paths` (`lib/dnd.ts`), which the panel can accept.

## Design

### References

A chat's **references** are the files and folders the assistant may read. They grow over the
chat's life: the person drops entries on the panel, uses **Add to chat** on a selection or a
row, or the assistant is told the folder the person is looking at. Each message records which
references were attached with it, so "these files" means what was just dropped, while the
tools may still read anything referenced earlier in the chat. The rest of the drive is
browsed the way Organize browses it (folder names, counts, search hits by folder).

Each message also carries the person's current **location** (the folder open in the browser,
or none on other pages) so "this folder" works without dropping it.

The Organize **Share with assistant** choices (`contents`, `otherFileNames`) apply unchanged,
chosen per chat and remembered by the browser. Files are never uploaded to the provider; only
text the tools return.

### Conversation loop

One chat is a server-side transcript plus, while it is active, an `AiConversation`. Sending a
message starts a turn: the agent loop runs tool calls until the model stops, with the caps
Organize uses (turn cap per message, authority check before every provider call, abort on
cancel).

Write tools do not write. When the model calls one, the loop verifies the arguments against
storage (the way `buildProposal` verifies moves), records a **pending action** on the
transcript and ends the turn in state `awaiting_approval`. The person then:

- **applies** it: the server executes the action under the same identity, re-checking
  authority and the storage state (SHA for edits, occupied targets for moves, Trash configured
  for trash), and continues the loop with the real outcome as the tool result;
- **declines** it: the loop continues with "The person did not apply this";
- **sends a new message**: pending actions are declined first, so provider history stays valid
  (every tool call gets a result). `AiInput` gains an optional `text` next to `tool_results`
  so a decline and the new message travel in one provider turn.

Edits to a pending action before applying (unchecking a move, choosing another folder, picking
"new file" over "replace") are sent with the approval and reflected in the tool result.

### Tools

Read tools reuse the Organize implementations, moved to a shared `ai/tools/` module with
`selected` generalized to the chat's references:

| Tool | Behavior |
| --- | --- |
| `folder_tree`, `list_folder`, `search_drive`, `similar_files` | As Organize, honoring `otherFileNames`. |
| `read_file` | Replaces `read_excerpts`. Referenced files only (including files inside a referenced folder). UTF-8 text is read from storage; PDFs, Office and scans return extracted index text through `runReadFileText`'s paging. Paged with `offset`, capped per call (about 40k characters) and per file (the MCP 4 MiB byte cap). Needs `contents`. |
| `file_info` | Size, dates, type, content hash, tags, whether the file is in a share, index status. Referenced files only. |
| `duplicates_of` | For one referenced file: other indexed files with the same SHA-256 (exact), then `similar_files` hits with similarity (near), then same-name files elsewhere. Indexed logins only. |

Action tools, all approval-gated:

| Tool | Verification before the card | Apply |
| --- | --- | --- |
| `move_items` | Same rules as Organize: each item referenced, destination outside Trash, outside the references and outside the item's current folder; `newFolder` and `conflict` flags. | `fs/move-many` semantics with `createParents`, per-item outcomes, client-side undo as today. |
| `trash_items` | Referenced items only; only offered when the login's storage has Trash configured (`principal.storage.trash`). Without Trash the tool is absent and the system prompt says deletion is not available from chat. | The delete route's trash path, per item, continuing past failures. |
| `write_text_file` | A referenced file (for replace) or a new path next to one. Text only, at most 1 MiB. Replace requires the SHA-256 from the `read_file` that produced the draft. Non-text originals (PDF, Office) can only get a new `.md` or `.txt` sibling. | Create with no overwrite, or replace after re-checking the SHA (lift `editFileUnlocked` out of the MCP token gate). The card shows a diff for replace and the full draft for a new file. |

Every tool runs with the principal's own storage and, for index-backed data, the verified
index scopes and live read authorizer Organize already uses. Accented paths go through
`stored-paths.ts`. A reference that no longer exists (moved, trashed) is reported as such by
the tools and shown struck through in the panel. File names and contents stay data; the system
prompt says so and a planted instruction can at most produce a card the person sees before
anything happens.

### Transcript and citations

The transcript is the wire shape the browser renders: messages with parts of kind `text`,
`tool` (one per tool call: name, the tool's one-line `activity`, a bounded input and output
summary and `running | done | failed`, rendered as a collapsed AI Elements `Tool` row) and
`action` (card with `pending | applied | declined | failed`, the verified proposal and the
outcome), plus the references attached to each person message. The server keeps the set of
paths tool results surfaced; absolute paths in assistant text that match it become
`citations`, which the UI renders as links to the file or folder. The system prompt asks the
assistant to refer to files by their full path.

### Persistence

Chats are stored, because a panel that follows the person around is expected to remember:

- `app.ai_chats`: id, identity, title (first message, editable), share choices, state,
  created/updated, `last_message_at`.
- `app.ai_chat_messages`: chat, ordinal, role, parts (JSON transcript parts), references,
  location, created.
- References are stored as paths, not file ids, so they follow the same rename rules as
  favorites and recents (`MetadataService` move/trash hooks update or mark them).

The live `AiConversation` (native provider history, including Claude's thinking blocks) is an
in-process cache keyed by chat id, evicted after an idle period. On a miss, the server rebuilds
provider history from the stored transcript: person messages with their references, assistant
text, and each tool call with its result. Pending actions are declined at rebuild, so the
rebuilt history never ends in an unanswered tool call. Tool results are stored in full up to a
per-part cap; a rebuilt history replaces old tool results beyond the last N turns with a
one-line summary to bound the prompt, which is also how long chats are compacted.

Limits: chats per identity (default 50, oldest deleted), retention after `last_message_at`
(default 90 days), messages per chat (default 200, then "Start a new chat"), running-turn
deadline (default 10 minutes), one running turn per identity (a new message to another chat
waits or replaces, the way Organize replaces). Deleting a chat removes its rows; deleting an
identity cascades.

### Transport

Turn progress reaches the browser over an SSE stream per chat (`GET /ai/chats/:id/events`),
built on the existing `streamSSE` route and the web `sse.ts` client: text deltas, activity
lines, action cards, state changes. `GET /ai/chats/:id` returns the whole transcript, so a
reload or a dropped stream recovers by refetching then resubscribing. The `AiModel` port gains
an optional `onText(delta)` on `send`; the Claude adapter already streams and forwards
deltas, the OpenAI-compatible adapter adds `stream: true` parsing.

### UI

- **Placement.** A panel mounted in the shell layout beside `SidebarInset`, not inside the
  file browser, so navigating between folders, Favorites, Recents, Tags, Search and System
  keeps it and its scroll position. Desktop: a resizable right column (a `resizable` shadcn
  primitive, width remembered as `fdrive.chat.width`) that pushes content. Below the `md`
  breakpoint: a full-height sheet. Open state and current chat id are `fdrive.chat.open` and
  `fdrive.chat.current` in localStorage, read through the `useSyncExternalStore` preference
  hooks so every tab agrees; the store hydrates the transcript from the server on mount.
- **Opening.** A header button (message icon, tooltip "Chat"), a keyboard shortcut next to the
  search one, the selection bar's **Add to chat** (opens the panel with the selection
  referenced) and the row context menu's **Add to chat**. Shown only while AI is available.
- **Drop to reference.** The whole panel is a drop target for `application/x-fdrive-paths`
  (`readDraggedPaths`), with a highlighted "Drop to add to chat" state while an internal drag
  is over it and `dropEffect` `copy` (listings allow copy or move, so `link` would cancel the drop). Dropped entries become reference chips in the composer;
  sending attaches them to that message. Chips above the composer are removable before send;
  earlier references are listed in a collapsible **References** header with links, and a
  missing one is struck through. Drops of OS files are refused with the usual copy (chat does
  not upload).
- **Chats.** A menu at the top lists recent chats by title and time, with New chat, Rename
  and Delete. The current chat id survives reloads; a deleted or expired chat falls back to a
  new one.
- **Components.** The transcript and composer use AI Elements (Vercel's shadcn registry,
  installed per component with `npx shadcn@latest add @ai-elements/<name>` into
  `components/ai-elements/`): `conversation` (stick-to-bottom scrolling and the scroll
  button), `message` with `MessageResponse` (streaming markdown through `streamdown`, which
  replaces `react-markdown` in the panel), `tool` (activity lines with input, output and
  state), `prompt-input` (the composer), `suggestion` (starter prompts for a fresh chat) and
  `loader`. The `ai` package comes along for its types only; nothing uses the AI SDK's
  transport or `useChat`. The code, math and mermaid extras (`shiki`, `katex`) are not
  installed. The project's shadcn style is Base UI (`base-nova`), so each installed
  component is checked against our `components/ui` primitives and adjusted the way the
  Base UI pitfalls describe. Action cards and reference chips are ours: `PromptInput`
  attachments are OS files, while references are internal paths.
- **Transcript.** Assistant text through `MessageResponse`; citations as links that navigate
  the browser to the folder and highlight the file; tool calls as collapsed `Tool` rows;
  action cards reuse the Organize review for moves (grouping by destination, conflicts
  unchecked, destination picker), a checkbox list for trash, and a diff or draft view for
  edits with new-file/replace toggle and file name. Stop while a turn runs, Retry after a
  failed turn, and the same failure copy as Organize (provider errors, session ended,
  refusal, cut off).
- **Activity corner.** With the panel closed, a running turn or pending cards show the
  Organize-style pill in the live activity dock, leading back to the panel.
- Organize stays as it is; its sheet is unchanged.

### Contracts and routes

`ROUTES.ai.chats`: `GET /ai/chats` (recent chats, no transcripts); `POST /ai/chats` (share) →
`Chat` (201); `GET /ai/chats/:id`; `PATCH /ai/chats/:id` (title); `DELETE /ai/chats/:id`;
`POST /ai/chats/:id/messages` (text, references, location) → 202; `GET /ai/chats/:id/events`
(SSE); `POST /ai/chats/:id/cancel`; `POST /ai/chats/:id/actions/:actionId` (`apply` with
edits, or `decline`). `ChatState` is `idle | running | awaiting_approval | failed | closed`.
Everything is per identity; a chat is `not_found` for any other identity, and switching the
active login shows that login's chats.

## Steps

Each step is one PR with the AGENTS.md checks; the earlier ones do not change what people see.

1. **Port and shared tools.** `AiInput` tool results with optional text; optional `onText`
   on `send` (Claude first). Move Organize's tools into `apps/api/src/ai/tools/` behind an
   `AiTool` type parameterized by the readable set; Organize keeps its behavior and tests.
2. **Chat core (API).** Done in the API (`apps/api/src/ai/chat/`, see the developer notes in
   [AI](../AI.md)): contracts, three tables (chats, messages, references) and migration, a
   chat repository, the loop with pending actions and history rebuild, `read_file`,
   `file_info`, `duplicates_of`, `move_items`, `trash_items`, `write_text_file`, the routes
   without SSE, with unit tests and the shared repository suite. Two deviations from the
   design above: references live in their own table so moves and trash can update them by
   path, and a rebuilt conversation replays the transcript as plain text (tool calls of the
   last few replies summarized inline) instead of native tool blocks, so it needs no
   provider-specific history. Pending cards survive a restart and can still be applied; only
   the assistant's continuation after them needs the live conversation.
3. **Chat panel.** Done in the web app (`apps/web/src/components/ai/chat/`, preferences and
   hooks in `apps/web/src/lib/ai/chat*.ts`). The spike kept `conversation`, `message`, `tool`,
   `prompt-input` and `suggestion` from AI Elements, each trimmed to what fdrive uses (no AI
   SDK types, no OS attachments, no code/math/mermaid plugins), see the notes in
   [PITFALLS](../PITFALLS.md); the `loader` item does not exist in the registry, and the resize
   handle is a small pointer handler rather than the `resizable` primitive. Originally: install
   the AI Elements components listed above,
   confirm they build and render on the Base UI primitives in a throwaway page, and record
   any adjustments. Then the shell-mounted panel, preferences, chat list, composer with
   drop-to-reference and Add to chat entry points, transcript rendering, action cards, apply
   and undo, polling `GET /ai/chats/:id` while a turn runs. e2e spec with a scripted fake
   (extend `e2e/support/fake-ai.ts` with chat scripts) covering: drop files from a listing,
   navigate to another folder and page with the panel open, reload and find the chat again,
   summarize, duplicate check, trash, move and rewrite; a real dev app check. Open from the
   browser check: the files toolbar decides inline versus overflow actions by viewport width
   (`useIsMobile`), so with the panel docked on a ~1300px window the selection bar overflows
   and the page scrolls sideways; it should follow the width the panel leaves (a container
   query or measured width). Deleting a chat has no confirm step.
4. **Streaming.** SSE route and client, deltas in the transcript, OpenAI-compatible streaming,
   reconnect and cancel behavior in browser checks.
5. **Docs.** Chat section in `docs/AI.md`, the data notice on System > AI describing what a
   chat sends and stores, `docs/ARCHITECTURE.md` boundary and UI lines (panel placement,
   preference keys, AI Elements under `components/ai-elements/`), `docs/MCP.md` note on the
   lifted edit helper, any Base UI adjustments to installed components in
   `docs/PITFALLS.md`; remove this plan.

## Complete when

- Each example question in Outcome works end to end in the dev app against real files, with
  the references dropped from a listing.
- The panel stays open, with its transcript and composer state, across folder navigation and
  every shell page; a reload and an API restart bring the same chat back.
- Answers and cards name only paths the login can read; cross-identity tests pass for every
  route and tool, and a token or another login never sees a chat.
- No storage write happens without an apply from the same identity; a stale SHA, an occupied
  target, a missing Trash and an ended session each refuse with a readable card state.
- Cancelling, reconnecting, reloading mid-turn and a failed provider turn behave predictably.
- Chats, messages and cached conversations are capped and evicted as configured; renaming
  or trashing a referenced file updates the reference.
- System > AI describes what chat sends and stores, and `docs/AI.md` documents the tools,
  limits and retention.
