# Connecting AI Assistants (MCP Server)

fdrive includes a built-in [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server. This allows AI assistants like **Claude Desktop**, **Claude.ai**, or **Raycast** to search, read, and explore your files securely on your behalf.

---

## How It Works

- **Strictly scoped**: The AI can only see files that your SFTPGo user has permission to read. It cannot peek into other users' drives or system files.
- **Read-only by default**: The AI cannot move, edit, or delete files unless you explicitly enable write permissions in your settings.
- **Direct connection**: Communicates directly over secure HTTP with a personal API token.

---

## Step 1: Create an API Token

1. Sign in to fdrive.
2. In the top-right corner, click on your user avatar and select **Account**.
3. In the **API Tokens** section, click **Create Token**.
4. Give your token a name (e.g. "Claude Laptop") and copy the secret token generated.

> [!IMPORTANT]
> The token is shown only once. Store it safely in your password manager or configuration.

---

## Step 2: Connect Your Assistant

### Option A: Claude Desktop
Run this command in your terminal (replace `<fdrive-url>` with your server address, and `<your-token>` with the token from Step 1):

```bash
claude mcp add --transport http fdrive http://<your-server-ip>:8090/mcp --header "Authorization: Bearer <your-token>"
```

### Option B: Claude.ai (Web Connector)
For web-based connectors that cannot set custom headers, use the token directly in the URL:
```
http://<your-server-ip>:8090/mcp/t/<your-token>
```

### Option C: Raycast Extension
In Raycast preferences for the fdrive extension:
1. Set **MCP Endpoint** to `http://<your-server-ip>:8090/mcp`
2. Set **Bearer Token** to your token from Step 1.

---

## What Tools Does the AI Have?

Once connected, your AI assistant can use the following tools:

| Tool | What it does |
| :--- | :--- |
| `search` | Hybrid semantic and keyword search across your documents with snippets. |
| `read_file_text` | Reads the text content of any readable document or code file. |
| `list_directory` | Lists files and folders in real time. |
| `find_files` | Finds files by name, file extension, date, or minimum size. |
| `file_info` | Shows file details (size, modification date, SHA-256 hash). |
| `find_duplicates` | Finds duplicate copies of files taking up wasted disk space. |
| `similar_files` | Finds documents semantically related to a given file. |
| `folder_overview` | Summarizes folder size, file counts, and top file types. |

---

## Enabling File Creation & Moves (Optional)

By default, the AI assistant cannot alter any files. If you want to allow the assistant to create folders or reorganize files:

1. In `/path/to/fdrive/deploy/.env`, add:
   ```dotenv
   FDRIVE_MCP_WRITES=true
   ```
2. Run `./update.sh`.

This activates the `create_folder` and `move_path` tools for all valid tokens.

Both tools only write inside the token identity's verified scope, the same paths the read tools can see. A path outside that scope, or in the Trash folder, is refused before storage is touched, and the tools are unavailable while the identity's scopes cannot be verified.
