# Connecting assistants to fdrive

The built-in MCP server works over HTTP at `/mcp`. Each API token belongs to one login and
has its own permissions and allowed folders. Indexed features (search and
analysis) cover that login's files, including folders shared with it, once its root is
indexed.

## Create a token

Open the sidebar account menu → **Account** → **Create token**. Choose a name, access level,
allowed folders and expiry; Read is the default. The token acts as your login. Enter one
absolute virtual folder per line, or `/` for all your folders.
The token is shown once. Copy it before closing the dialog.

| Access | Available actions |
| --- | --- |
| Read | Browse, original/text/image reads, file metadata, tags and indexed search/analysis. |
| Organize | Read plus folder creation, move/rename/copy, file tags and favorites. |
| Full management | Organize plus create/upload/edit and recoverable Trash/restore. |

Tokens never confer administration and reach only their own login's files. Every HTTP request
checks that the token is unrevoked and unexpired and that the fdrive user is neither disabled
nor removed.

## Connect

Use your externally reachable HTTPS address, for example `https://drive.example.com`.
For Claude Code, run the command shown after creating the token:

```sh
claude mcp add --transport http fdrive https://drive.example.com/mcp --header "Authorization: Bearer <token>"
```

That command configures Claude Code. Other MCP clients can use the endpoint and Bearer
header directly. Clients which cannot send an authorization header can use
`https://drive.example.com/mcp/t/<token>` instead. That complete URL is a credential;
keep it out of shared messages and logs. A hosted client must be able to reach the server.

For Raycast or another configurable client, set the MCP endpoint to
`https://drive.example.com/mcp` and the Bearer token to the generated value.

## Tools

Discovery omits tools the token cannot use. Every handler also enforces its permissions.
Tools carry MCP read/write annotations; permission to execute a tool is separate from an
assistant deciding whether the user requested that action.

| Tools | Behavior |
| --- | --- |
| `capabilities` | Login, grants, access level, optional processing and file-size limits. |
| `list_directory` | Live provider listing; `next_offset` continues a page. |
| `file_info` | Live metadata from storage: kind, size, modification time and link. |
| `read_file_text` | UTF-8 directly; PDF/Office/image text through optional extraction. Includes SHA-256, offset and continuation. |
| `read_file`, `read_image` | Original base64 bytes, or PNG/JPEG/GIF/WebP MCP image content. |
| `search`, `search_images` | Text/semantic search or visual-description search. Processing may be unavailable or degraded. |
| `find_files` | Indexed name/type/date/size filtering with `next_offset`. |
| `find_duplicates`, `similar_files`, `folder_overview`, `index_stats` | Indexed analysis, live-authorized against the provider. |
| `recent_moves` | This login's moves through MCP, newest first, from [personal activity](ACTIVITY.md); both paths inside the token's folders. |
| `create_folder`, `move_path`, `copy_path` | Organization within allowed folders. Occupied destinations are refused. |
| `file_tags`, `set_file_tags`, `set_favorite` | Read/replace file tags and toggle favorites. Missing tag names are created. |
| `create_file`, `upload_file` | Create UTF-8 text or canonical base64 bytes; no overwrite. |
| `edit_file` | Replace UTF-8 text only with the SHA-256 from a previous read. |
| `trash_path`, `list_trash`, `restore_path` | Recoverable removal and restoration. |

## Access and limitations

Direct operations enforce normalized folder grants and current provider permissions. Browsing
an ancestor of an allowed folder reveals only the directory chain leading to that folder.
Ordinary operations and indexed results exclude fdrive's own folders: the Trash at `/.trash`,
the Mac app's `/.fdrive-desktop` and Trash's old layout. Moving or deleting a grant root is
refused. Restore checks both the original and
requested destination paths. There are no permanent-delete or public-sharing tools.

Index-derived data intersects grants with verified index mappings and live provider read
proofs. A login whose root is not indexed can still browse/read/organize/manage files; it does
not gain access to index rows by guessing a mapping. Search and bounded aggregates report partial,
degraded or unavailable results. Follow `next_offset` for listings; concurrent directory
changes can shift pages. Trash listing scans at most 10,000 provider entries and reports
`partial` if that bound is reached.

File reads, uploads and text replacements are capped at **4 MiB**. The server enforces the cap
on streamed bytes, not only reported file size. `read_file_text` pages the extracted text;
source files still must fit the byte cap. Document extraction requires `FDRIVE_INDEXER_URL`
and appropriate processing dependencies (the ml service for Office documents, configured OCR
for images/scans).
The internal `/extract-content` endpoint accepts bounded bytes already read from storage,
writes a temporary extraction file, removes it afterward, and never takes a
filesystem path. It also works while the files folder is not indexed. Extraction status describes
unsupported formats, disabled processing and documents without extracted text.

`recent_moves` returns `{ at, src, dst }` per move. It is history: a destination may have
moved or gone since, and the login's moves through any of its tokens are listed. It reads at
most 2,000 events and reports `partial` if it stopped there short of `limit`.

Creation, moves and copies leave an occupied destination to storage, which refuses it
(creation atomically). Editing checks SHA-256 and serializes competing MCP edits within one
API process; that check is not atomic against other API processes, browser writes or
writers outside fdrive. Re-read before editing; avoid concurrent external edits.
Writes go through the same file operations as the web, recorded in personal activity the same
way. A move, Trash or restore whose links and shares with people cannot follow fails and leaves
the file where it was. Once a write completes, a failure in tags, favorites or the rest of what
is kept by path is a warning; do not retry the storage operation merely to repair it.

## MCP and REST vocabulary

MCP tools are task-oriented interfaces, not a mirror of REST payloads. `move_path`
accepts `src`/`dst`; REST `/fs/move` accepts `path`/`target`. `set_file_tags` accepts
names and creates missing tags; REST `/fs/tags` accepts existing tag IDs and refuses
unknown IDs. Both routes enforce the caller's identity and permissions.
