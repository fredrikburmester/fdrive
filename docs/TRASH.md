# Setting up Trash (Recycle Bin)

fdrive includes a full Trash interface with **Restore** and **Delete permanently** buttons.

Rather than managing deleted files in a separate database, fdrive uses SFTPGo's built-in Event Manager to move files into a `/.trash` folder when they are deleted. This provides a major benefit: **any file you delete, whether through fdrive, SFTP, or directly on disk, safely ends up in the same recycle bin.**

---

## Step 1: Enable Trash in fdrive

In your `deploy/.env` file, make sure these two lines are present:

```dotenv
FDRIVE_SFTPGO_TRASH_PATH=/.trash
FDRIVE_SFTPGO_TRASH_RETENTION_HOURS=720
```

- `FDRIVE_SFTPGO_TRASH_PATH`: The folder where trashed files are stored (`/.trash`).
- `FDRIVE_SFTPGO_TRASH_RETENTION_HOURS`: Tells fdrive how long to display that files are kept (720 hours = 30 days).

If you changed these, restart fdrive by running `./update.sh`.

---

## Step 2: Configure the rule in SFTPGo

Log in to your **SFTPGo Web Admin** (typically at `http://<sftpgo-server>:8080/web/admin` or port `8091`).

In the sidebar, open **Event Manager**. We need to create one **Action** and one **Rule**.

### 1. Create the Action
1. Under **Actions**, click **Add** (`+`).
2. Fill in:
   - **Name**: `fdrive-move-to-trash`
   - **Type**: `Filesystem`
   - **Sub-type**: `Rename`
   - **Rename from**: `/{{.VirtualPath}}`
   - **Rename to**: `/.trash/{{.VirtualDirPath}}/{{.ObjectName}}/{{.Timestamp}}`
3. Click **Save**.

### 2. Create the Rule
1. Under **Rules**, click **Add** (`+`).
2. Fill in:
   - **Name**: `fdrive-trash`
   - **Trigger**: `Filesystem events`
   - **Events**: Check `pre-delete`
   - **Path filter**: Add `/.trash/**` and **check "Inverse match"** (this ensures deleting something inside the trash folder deletes it permanently instead of looping).
   - **Actions**: Select `fdrive-move-to-trash`, and check both **"Execute sync"** and **"Stop on failure"**.
3. Click **Save**.

---

## Step 3: Test it

1. Open fdrive in your browser.
2. In your file list, select a test file and click **Move to Trash**.
3. Open **Trash** in the left sidebar.
4. You will see your file with its original path and deletion date!
5. Click **Restore** to return the file to where it came from, or **Delete forever** to permanently purge it.

---

## Optional: Automatically Emptying Old Files

To make SFTPGo automatically purge files older than 30 days (720 hours):

1. In SFTPGo Event Manager, go to **Actions** > **Add**:
   - **Name**: `fdrive-trash-retention`
   - **Type**: `Data retention check`
   - **Folder**: `/.trash`
   - **Retention**: `720` hours
   - Check **"Delete empty dirs"** and **"Ignore user permissions"**.
   - Click **Save**.
2. Go to **Rules** > **Add**:
   - **Name**: `fdrive-trash-retention`
   - **Trigger**: `Schedule`
   - **Schedule**: Run once daily (e.g. at 3:00 AM)
   - **Action**: Select `fdrive-trash-retention`
   - Click **Save**.

---

## Good to Know

- **Folder deletions**: When you delete a whole folder, SFTPGo moves each file inside it to the trash individually, preserving its full path.
- **Overwrites**: Uploading or saving over an existing file is an overwrite, not a deletion, so previous versions are not sent to the trash.
- **Permanent deletes**: Deleting items directly inside the Trash view will permanently remove them from your disk.
