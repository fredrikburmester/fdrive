# Trash setup

Trash is the seventh optional choice in fdrive onboarding, after the six processing
features. It can also be changed in **System > General > Trash**. No environment
variables, worker, local storage mount, or restart are required.

How deleted files reach the recycle folder depends on the storage provider. For SFTPGo,
fdrive uses SFTPGo's Event Manager recycle-bin rule (sections 1–3 below). For WebDAV,
fdrive moves deleted files into the folder itself; see
[Providers where fdrive performs the move](#providers-where-fdrive-performs-the-move).
Either way, fdrive does not intercept filesystem operations outside the provider. Deleting
directly on the host disk bypasses this integration; overwriting a file does not retain its
previous version.

## 1. Configure SFTPGo

An SFTPGo administrator configures the following in **WebAdmin > Event Manager**.
Keep WebAdmin credentials in SFTPGo; fdrive only uses file-user accounts.
The recipe matches the SFTPGo 2.7.5 integration fixture tested by this repository.

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


Enable the rule. Ensure it applies to every user who will use Trash, and that those
users can write to the recycle folder. `/.trash` is relative to each user's home.
If using another folder, replace it consistently in the action, inverse filter,
and fdrive settings.

## 2. Verify the rule before enabling fdrive Trash

Using an ordinary SFTPGo file-user account, upload a disposable file in WebClient
and delete it. Confirm its contents remain at
`/.trash/<original directory>/<filename>/<timestamp>`. Test each distinct user or
storage policy affected by the rule. A connection test alone does not verify recycling.

If the file disappears permanently or the delete fails, correct the Event Manager
rule and permissions before enabling the fdrive integration. Check SFTPGo's logs.

## 3. Enable Trash in fdrive

1. In onboarding's **Trash** step, turn on **Enable Trash**.
2. Enter the recycle folder, normally `/.trash`.
3. Optionally enter retention hours matching your SFTPGo cleanup schedule.
4. Confirm that you configured and tested the rule, then **Save and continue**.
5. Finish setup. Delete a disposable file using **Move to Trash**, open **Trash**,
   and test **Restore**. **Delete permanently** and **Empty Trash** permanently purge items.

The setting takes effect immediately for this SFTPGo connection. It applies to its
users; they do not repeat onboarding. Each user's own permissions still apply.
Switching to a different SFTPGo provider requires configuring and confirming Trash
for that provider; confirmation is not carried across connections.

You may **Skip Trash** and enable it later in **System > General**. Disabling the
integration hides fdrive's Trash controls; it does not remove existing items or
change SFTPGo rules. A configured SFTPGo rule can still recycle subsequent deletions.

## Providers where fdrive performs the move

A WebDAV server has no recycle bin, so fdrive's API moves each deleted file or folder into
the Trash folder on that server (`/.trash` by default, relative to each user's home) and
lists, restores and purges it from there. Nothing is configured on the server:

1. Sign in through the WebDAV login as an administrator and open **System > General >
   Trash** (or the onboarding **Trash** step). The card says that fdrive moves deleted files
   itself and shows no rule-confirmation checkbox.
2. Turn on **Enable Trash**, keep or change the folder, optionally note a retention period,
   and save. The folder is created on the first delete.
3. Delete a disposable file with **Move to Trash**, open **Trash** and test **Restore**.

Deleted items live under `<folder>/.fdrive-move-v1/…`, a layout that keeps long, Unicode and
literal-percent names reversible; do not point a WebDAV row's Trash at a folder that an
SFTPGo recycle rule also writes to. Deleting inside the Trash folder is permanent, which is
how **Delete permanently** and **Empty Trash** work. Retention is informational here too:
fdrive never removes old items on its own.

Trash settings belong to the active login's storage row, so the administrator opens them
with the WebDAV login active. That takes an account-wide administrator (the owner account
from the setup claim); an environment administrator (`FDRIVE_ADMIN_USERS`) is one only
while their SFTPGo login is active and cannot configure a WebDAV row's Trash. Where one home is
served by both an SFTPGo login and a WebDAV login, give the WebDAV row its own folder (for
example `/.trash-webdav`) so the two layouts never share a root, and add that folder to the
SFTPGo rule's inverse path filter (`/.trash-webdav/**`); otherwise the rule recycles the
WebDAV Trash's permanent deletes into `/.trash` instead of removing them. Each login hides
only its own Trash folder from listings, so the SFTPGo rule's `/.trash` shows as an ordinary
folder over WebDAV.

## Optional retention

Configure automatic cleanup in SFTPGo Event Manager with a scheduled data-retention
check for the recycle folder. Choose its retention and schedule for your deployment
and test on disposable files before applying it broadly.

The retention value in fdrive is informational only. Entering hours does not create
a schedule or delete old files. Leave it blank if no retention schedule is configured.
