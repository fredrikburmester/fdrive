# AI organize

Select files and folders, choose **Organize**, and fdrive suggests where each item belongs
elsewhere in the drive. Nothing moves until the person reviews the suggestions and applies them.

## Set up

An administrator opens **System > AI > Settings**:

| Provider | Needs | Notes |
| --- | --- | --- |
| Anthropic (Claude) | API key | Default model `claude-opus-5`. The api container needs outbound HTTPS to `api.anthropic.com`. |
| OpenAI-compatible server | Base URL, model | Ollama, LM Studio, vLLM or OpenRouter. Choose a model that supports tool calling. The key is optional. |

**Check connection** verifies the key, address and model without generating text. Two switches
turn the features on for everyone signed in: **Organize** puts Organize in the selection bar and
the row context menu, and **Chat** shows the chat panel. Either works on its own.

The key is sealed with `FDRIVE_MASTER_KEY` and bound to the provider and base URL it was
entered for. Changing either removes the saved key unless a new one is entered, so a key is
never forwarded to a different address. A key that no longer decrypts (a rotated master key)
shows as missing.

## Chat

With Chat on, a **Chat** button in the page header (or Cmd+Shift+K, Ctrl+Shift+K elsewhere)
opens a panel beside the page that stays open while you move between folders and pages. Drop
files or folders onto it from any listing, or use **Add to chat** from a selection or a row's
menu, then ask: what the files are about, whether one is a duplicate, whether they can be
removed, where they should go, or for a more professional version of a text file. The
assistant reads only what you attached (and what is inside attached folders) and answers with
links to the files it talks about.

When it wants to change something, it shows a card instead: moves grouped by destination that
you can uncheck or redirect, items to move to Trash (only where Trash is configured), or a new
text file (or a new version of an attached text file) whose text you see first. Nothing happens
until you apply the card; the assistant then continues with the outcome. Sending a new message
declines any waiting cards. Recent chats are in the panel's menu; a chat keeps its transcript
across reloads and stays for 90 days after its last message.

## What is sent

- Paths, sizes and dates of the selected items, and the names of folders the assistant lists
  while exploring the drive.
- The person's optional instructions.
- Optionally, chosen per run in the **Share with assistant** multi-select of the Organize sheet
  and remembered by the browser:
  - **File contents**: up to 1,500 characters of already-extracted index text per selected
    file, when the login has verified index scopes ([scoping](SCOPING.md)). Off removes the
    `read_excerpts` tool and tells the assistant to decide from names, types, sizes, dates and
    the folder structure. Search and similar files still work; they never return text.
  - **Names of other files**: file names outside the selection seen in `folder_tree`,
    `list_folder`, `search_drive` and `similar_files`. Off leaves folder names and file counts.

Files are never uploaded. Search and similar-file tools report which folders hold matches, not
other files' contents. The request carries the choice as `share`; an omitted `share` means both.

## How a run works

1. `POST /api/v1/ai/organize` starts an in-memory run and returns `202`. A login has one running
   run: a new request replaces it, so a reload or closed tab never blocks the next one. Runs stop
   after 30 minutes, stay readable for an hour and are lost on restart. The browser polls
   `GET /api/v1/ai/organize/:id`. Closing the sheet keeps the run and its review: a pill in the
   bottom-right activity corner, next to uploads and jobs, shows "Organizing…" or "Suggestions
   ready" until the sheet is reopened, and a toast offers to review suggestions that arrived
   while it was closed. Stop, Start over, applying every move or
   organizing another selection ends a session; a reload loses it.
2. The organizer runs a tool loop with **read-only** tools: `folder_tree`, `list_folder`, and,
   for indexed logins, `read_excerpts`, `search_drive` and `similar_files`. It ends by calling
   `submit_suggestions`. Runs stop after 40 turns, and the session's authority is re-checked
   before every turn.
3. The server checks every suggestion against storage: it must name a selected item and a
   destination outside Trash, outside the selection and outside the item's current folder. Each
   suggestion is marked when its folder is new or its target name is taken. Unusable
   suggestions, and ones storage could not check, are listed as unchanged with the reason.
   Paths are matched by how names read, since macOS stores accents as separate marks and models
   write them as single characters: `Husarö` finds the stored folder instead of becoming a
   look-alike new one. The tools resolve paths the same way.
4. The review groups suggestions by destination. Conflicts start unchecked, and any item can be
   pointed at another folder. **Move** calls `POST /api/v1/fs/move-many` with
   `createParents: true`. That endpoint moves items in order, continues past failures, never
   overwrites, and reports each outcome. It checks each source before creating folders, so an
   item that cannot move leaves none behind. **Undo** sends the reverse moves, for the login
   that made them; folders created by the apply stay.

File names and contents reach the model as data. A prompt injection can at most produce bad
suggestions, which the person still has to approve; the organizer has no tool that writes.

## Developer notes

- `apps/api/src/ai/model.ts` is the provider-neutral port. Each adapter keeps its own native
  history, so Claude's thinking blocks are replayed unchanged between tool calls.
- The Claude adapter reads the model's entry from the Models API once per run and uses adaptive
  thinking and up to 32k output tokens only where that entry allows. It streams every turn with
  automatic prompt caching and server-side refusal fallbacks on `claude-opus-5` and
  `claude-fable-5-1`. The OpenAI-compatible adapter uses `fetch`, refuses redirects and allows
  five minutes per turn.
- The tools live in `apps/api/src/ai/tools/`, shared with the planned chat: `tool.ts` is the
  `AiTool` shape and the executor every agent loop uses, `drive-tools.ts` the read-only drive
  tools built for one *focus* (the items the assistant may read the contents of, and whether it
  may open folders among them; Organize's focus is the selection, closed). They reuse the MCP
  read handlers (`runSearch`, `runSimilarFiles`) and index scoping; see [MCP](MCP.md).
  `IndexQueries.fileTextPrefix` reads excerpts without touching originals.
- Chat (`apps/api/src/ai/chat/`, routes under `/api/v1/ai/chats`) is the API side of
  [AI chat](plans/AI-CHAT.md); the panel is not built yet. A chat's *references* (the files and
  folders a person attached) are the tools' focus; `service.ts` stores transcripts and references
  through `AiChatRepo` (`app.ai_chats`, `app.ai_chat_messages`, `app.ai_chat_references`), keeps
  one live provider conversation per active chat in memory (`live.ts`) and rebuilds it from the
  transcript as plain text after a restart (`history.ts`). Read tools (`tools.ts`: `read_file`,
  `file_info`, `duplicates_of`) run at once. Write tools (`action-tools.ts`: `move_items`,
  `trash_items` where Trash is configured, `write_text_file`) never write: `agent.ts` verifies
  the call into a pending action card, the turn pauses in `awaiting_approval`, and only
  `POST /ai/chats/:id/actions/:actionId` applies it under the same identity, re-checking the
  session, SHA-256 and targets, before the assistant continues with the outcome. A new message
  declines any pending cards first. References follow moves and are marked missing on delete
  through `MetadataService`.
