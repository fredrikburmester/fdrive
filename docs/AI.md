# AI organize

Select files and folders, choose **Organize**, and fdrive suggests where each item belongs
elsewhere in the drive. Nothing moves until the person reviews the suggestions and applies them.

## Set up

An administrator opens **System > AI > Settings**:

| Provider | Needs | Notes |
| --- | --- | --- |
| Anthropic (Claude) | API key | Default model `claude-opus-5`. The api container needs outbound HTTPS to `api.anthropic.com`. |
| OpenAI-compatible server | Base URL, model | Ollama, LM Studio, vLLM or OpenRouter. Choose a model that supports tool calling. The key is optional. |

**Check connection** verifies the key, address and model without generating text. Once AI is on,
**Organize** appears in the selection bar and the row context menu for everyone signed in.

The key is sealed with `FDRIVE_MASTER_KEY` and bound to the provider and base URL it was
entered for. Changing either removes the saved key unless a new one is entered, so a key is
never forwarded to a different address. A key that no longer decrypts (a rotated master key)
shows as missing.

## What is sent

- Paths, sizes and dates of the selected items, and folder and file names the assistant lists
  while exploring the drive.
- Up to 1,500 characters of already-extracted index text per selected file, when the login has
  verified index scopes ([scoping](SCOPING.md)). Files are never uploaded.
- The person's optional instructions.

Search and similar-file tools report which folders hold matches, not other files' contents.

## How a run works

1. `POST /api/v1/ai/organize` starts an in-memory run and returns `202`. A login has one running
   run: a new request replaces it, so a reload or closed tab never blocks the next one. Runs stop
   after 30 minutes, stay readable for an hour and are lost on restart. The browser polls
   `GET /api/v1/ai/organize/:id`; closing the sheet cancels the request, even one still starting.
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
- The tools reuse the MCP read handlers (`runSearch`, `runSimilarFiles`) and index scoping; see
  [MCP](MCP.md). `IndexQueries.fileTextPrefix` reads excerpts without touching originals.
- Chat with files is planned in [AI chat](plans/AI-CHAT.md).
