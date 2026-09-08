# Trash setup

Trash is the seventh optional choice in fdrive onboarding, after the six processing
features. It can also be changed in **System > Features > Trash**. No environment
variables, worker, local storage mount, or restart are required.

fdrive uses SFTPGo's Event Manager recycle-bin rule. It does not create that rule or
intercept filesystem operations outside SFTPGo. Deleting directly on the host disk
bypasses this integration; overwriting a file does not retain its previous version.

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

You may **Skip Trash** and enable it later in **System > Features**. Disabling the
integration hides fdrive's Trash controls; it does not remove existing items or
change SFTPGo rules. A configured SFTPGo rule can still recycle subsequent deletions.

## Optional retention

Configure automatic cleanup in SFTPGo Event Manager with a scheduled data-retention
check for the recycle folder. Choose its retention and schedule for your deployment
and test on disposable files before applying it broadly.

The retention value in fdrive is informational only. Entering hours does not create
a schedule or delete old files. Leave it blank if no retention schedule is configured.
