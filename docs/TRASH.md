# Trash setup

Trash is the seventh optional choice in fdrive onboarding, after the six processing
features. It applies to every user of the files folder and stays editable under
**System > General**. No environment variables, worker or restart are required.

fdrive moves each deleted file or folder into the Trash folder in that user's own files
(`/.trash` by default) and lists, restores and purges it from there. fdrive does not intercept
changes made outside it: deleting directly on the host disk bypasses Trash, and overwriting a
file does not retain its previous version.

## Enable Trash

1. In onboarding's **Trash** step, or under **System > General**, turn on **Enable Trash**.
2. Keep or change the folder, normally `/.trash`. fdrive creates it on the first delete.
3. Optionally note a retention period (see below), then save.
4. Delete a disposable file using **Move to Trash**, open **Trash** and test **Restore**.
   **Delete permanently** and **Empty Trash** permanently purge items.

The setting takes effect immediately for every user; they do not repeat onboarding.
You may **Skip Trash** and enable it later. Disabling it hides fdrive's Trash controls; it
does not remove items already in the folder.

## Where deleted items live

Deleted items live under `<folder>/.fdrive-move-v1/…` in each user's files, a layout that
keeps long, Unicode and literal-percent names reversible. On the host that is
`<files folder>/<username>/.trash/.fdrive-move-v1`. Deleting inside the Trash
folder is permanent, which is how **Delete permanently** and **Empty Trash** work. Trash
lists, restores and empties only what fdrive put there; other files in the Trash folder are
left alone.

A restore never replaces anything: when a file or folder already sits at the original path,
the restore fails with a conflict, and **Restore to** can pick another place.

When a folder shared with other users goes to Trash, its shares go with it, and nobody it is
shared with can reach it there, even after Trash is turned off or moved. A new folder at the old
path is not shared. A restore, to the same place or another, brings the
share back; deleting the item permanently, in fdrive or on the host, ends it. Tags and favorites
stay at the original path for a restore there.

Reaching System takes an administrator: the setup owner, a user made administrator under
**System > Users**, or a username in `FDRIVE_ADMIN_USERS`.

## Optional retention

The retention value in fdrive is informational only. Entering hours does not create a
schedule or delete old files, and fdrive never removes old items on its own. To clean up
automatically, schedule it on the host, and test on disposable files
before applying it broadly. Leave the value blank if no retention schedule is configured.
