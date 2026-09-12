# Connecting assistants to fdrive

The built-in MCP server works over HTTP at `/mcp`. Each API token belongs to one linked
storage login and has its own permissions and allowed folders. SFTPGo and WebDAV use the
same tools; indexed features additionally require a verified index mapping.

## Create a token

Open the sidebar account menu → **Account** → **Create token**. Choose a name, storage login,
access level, allowed folders and expiry. The active login is selected initially; Read is the
default. Enter one absolute virtual folder per line, or `/` for all folders in that login.
The token is shown once. Copy it before closing the dialog.

| Access | Available actions |
| --- | --- |
| Read | Browse, original/text/image reads, file metadata, tags and indexed search/analysis. |
| Organize | Read plus folder creation, move/rename/copy, file tags and favorites. |
| Full management | Organize plus create/upload/edit and recoverable Trash/restore. |

Tokens do not confer administration or access to other linked logins. Revocation, expiry,
current identity ownership and provider credentials are checked on every HTTP request.
Changing the active login in the browser does not retarget an existing token.

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
| `file_info` | Live metadata for explicit tokens; indexed metadata for legacy tokens. |
| `read_file_text` | UTF-8 directly; PDF/Office/image text through optional extraction. Includes SHA-256, offset and continuation. |
| `read_file`, `read_image` | Original base64 bytes, or PNG/JPEG/GIF/WebP MCP image content. |
| `search`, `search_images` | Text/semantic search or visual-description search. Processing may be unavailable or degraded. |
| `find_files` | Indexed name/type/date/size filtering with `next_offset`. |
| `find_duplicates`, `similar_files`, `folder_overview`, `index_stats` | Indexed analysis, live-authorized against the provider. |
| `recent_moves` | Mapped MCP move history, with both paths restricted to the token. |
| `create_folder`, `move_path`, `copy_path` | Organization within allowed folders. Occupied destinations are refused. |
| `file_tags`, `set_file_tags`, `set_favorite` | Read/replace file tags and toggle favorites. Missing tag names are created. |
| `create_file`, `upload_file` | Create UTF-8 text or canonical base64 bytes; no overwrite. |
| `edit_file` | Replace UTF-8 text only with the SHA-256 from a previous read. |
| `trash_path`, `list_trash`, `restore_path` | Recoverable removal and restoration when Trash is configured for that login. |

## Access and limitations

Direct operations enforce normalized folder grants and current provider permissions. Browsing
an ancestor of an allowed folder reveals only the directory chain leading to that folder.
Ordinary operations exclude configured Trash. Moving/deleting a grant root or a folder
containing Trash is refused. Restore checks both the original and requested destination paths.
There are no permanent-delete or public-sharing tools.

Index-derived data intersects grants with verified index mappings and live provider read
proofs. An unindexed WebDAV login can still browse/read/organize/manage files; it does not gain
access to index rows by guessing a mapping. Search and bounded aggregates report partial,
degraded or unavailable results. Follow `next_offset` for listings; concurrent directory
changes can shift pages. Trash listing scans at most 10,000 provider entries and reports
`partial` if that bound is reached.

File reads, uploads and text replacements are capped at **4 MiB**. The server enforces the cap
on streamed bytes, not only reported file size. `read_file_text` pages the extracted text;
source files still must fit the byte cap. Document extraction requires `FDRIVE_INDEXER_URL`
and appropriate processing dependencies (Tika for Office, configured OCR for images/scans).
The internal `/extract-content` endpoint accepts bounded bytes already read through the
provider, writes a temporary extraction file, removes it afterward, and never takes a
filesystem path. It also works when no index roots are mounted. Extraction status describes
unsupported formats, disabled processing and documents without extracted text.

Creation, moves and copies use provider no-overwrite support plus a destination check.
Editing checks SHA-256 and serializes competing MCP edits within one API process. The current
provider contract cannot make those checks atomic against other API processes, browser
writes or external storage clients. Re-read before editing; avoid concurrent external edits.
Completed storage mutations remain successful if metadata/history updates fail, with warnings
explaining what was not updated. Do not retry the storage operation merely to repair a warning.

## Existing tokens

Tokens created before explicit access was introduced retain **Legacy** access. Their direct
text reads, indexed analysis and writes retain the existing verified-index admission rules;
legacy browsing continues to use the provider. Only their `create_folder` and `move_path`
permissions depend on `FDRIVE_MCP_WRITES` (default false).

New tokens use their own Read/Organize/Full settings regardless of that legacy flag. Existing
tokens never silently gain the new file-management tools. Create a replacement token to
choose login/folders/permissions, update the client, then revoke the old token.
