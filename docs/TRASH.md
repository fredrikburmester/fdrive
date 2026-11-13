# Trash setup

Trash is the seventh optional choice in fdrive onboarding, after the six processing
features, where it configures the storage the administrator signed in to. It is a
per-server setting: every storage server keeps its own under **System > Storage**, on that
server's row, whichever login the tab is browsing as. No environment variables, worker,
server rule or restart are required.

fdrive moves each deleted file or folder into the Trash folder in that user's own files
(`/.trash` by default) and lists, restores and purges it from there. This works the same on
the local files folder, WebDAV and S3. fdrive does not intercept changes made outside it:
deleting directly on the host disk, or with another client of a WebDAV or S3 server, bypasses
Trash, and overwriting a file does not retain its previous version.

## Enable Trash

1. In onboarding's **Trash** step, or on the server's row under **System > Storage**, turn on
   **Enable Trash**.
2. Keep or change the folder, normally `/.trash`. fdrive creates it on the first delete.
3. Optionally note a retention period (see below), then save.
4. Delete a disposable file using **Move to Trash**, open **Trash** and test **Restore**.
   **Delete permanently** and **Empty Trash** permanently purge items.

The setting takes effect immediately for that server's users; they do not repeat onboarding.
You may **Skip Trash** and enable it later. Disabling it hides fdrive's Trash controls; it
does not remove items already in the folder.

## Where deleted items live

Deleted items live under `<folder>/.fdrive-move-v1/…` in each user's files, a layout that
keeps long, Unicode and literal-percent names reversible. On the local files folder that is
`<files folder>/<username>/.trash/.fdrive-move-v1` on the host. Deleting inside the Trash
folder is permanent, which is how **Delete permanently** and **Empty Trash** work.

Coming from SFTPGo, items its recycle rule moved to `.trash` stay on disk but are not listed
in Trash. Remove them with the host's own tools once you no longer need them.

Trash settings belong to the storage row, and System > Storage edits any row from any login.
Reaching System at all takes an administrator: the setup owner, a user made administrator
under **System > Users**, or a username in `FDRIVE_ADMIN_USERS` while browsing as their local
login.

## Optional retention

The retention value in fdrive is informational only. Entering hours does not create a
schedule or delete old files, and fdrive never removes old items on its own. To clean up
automatically, schedule it on the host or storage server, and test on disposable files
before applying it broadly. Leave the value blank if no retention schedule is configured.
