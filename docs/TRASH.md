# Trash

Trash is always on, for every user. A deleted file or folder waits in its user's Trash, at
`/.trash` in their files, until they restore it, delete it permanently, or Trash has kept it
longer than the installation's retention. There is nothing to turn on, no folder to choose,
and no worker or restart.

Every delete in fdrive moves to Trash: the web app, MCP's `trash_path`, AI chat's cards, Finder
in an FDrive for Mac location (Move to Trash and Delete Immediately alike) and a Mac save that
renames its file. Finder's Trash for a location is this Trash; Empty Trash there deletes for
good, as **Delete permanently** does ([macOS](MACOS.md#trash)). Storage itself never decides:
`deleteFile` and `deleteDir` delete for good, and `trash.put` moves an item into Trash and says
where, so each caller chooses. fdrive does not intercept changes made outside it: deleting
directly on the host disk bypasses Trash, and overwriting a file does not retain its previous
version.

## Retention

**Days in Trash**, under **System > General**, is Trash's one setting: how long it keeps an
item, 30 days until an administrator changes it, from 1 to 3650. The API checks every user's
Trash hourly, the first time an hour after it starts, and deletes each item its row says went
there longer ago than that permanently, the way **Delete permanently** does: the user's history records it as a
permanent delete with the reason `retention`, and shares and links that followed the item into
Trash end. A user who may not sign in keeps their Trash until they may again. The Trash page
and the delete dialog say how long items stay.

## Where deleted items live

Each deleted item lives in a folder of its own, under its own name: `/.trash/<id>/<name>` in its
user's files, `<files folder>/<username>/.trash/<id>/<name>` on the host, where `<id>` is an id
fdrive makes. Where it was deleted from and when are kept in the database
(`app.trash_items`), one row per item, so the Trash page reads one query and a restore or a
permanent delete finds its item by id. An item's path in Trash is never much longer than its
name, so a delete deep in the files works wherever the item itself does. Deleting inside the
Trash folder is permanent, which is how **Delete permanently**, **Empty Trash** and retention
work. Trash lists, restores and empties only what has a row; other files in the Trash folder
are left alone. A restore removes the item's folder, and a permanent delete removes the folder
with the item.

The row is written before the item moves and the item arrives with what follows it in one
transaction, so an item is never in Trash without its row. When a delete is interrupted, by a
crash say, the API settles it at its next start, before it serves anyone: an item that reached
Trash arrives with everything that follows it there, and one that did not stays where it was.

A restore never replaces anything: when a file or folder already sits at the original path,
the restore fails with a conflict, and **Restore to** can pick another place.

Everything fdrive keeps by path goes into Trash with the item: tags, favorites, folder views,
recents, Office documents, folders shared with other users and public links. Nobody reaches it
through a share or link there, no list shows it, and a new item at the old path inherits nothing.
Links, shares, Office documents and the item's row change in one transaction with its move,
before it: when the database refuses that, the item stays where it was and the delete fails, so
none of them stays at the path it left. A permanent delete ends them first and deletes nothing
when it cannot.
A restore, to the same place or another, is a move back, so it all comes back with the item;
deleting it permanently, in fdrive or on the host, ends it. An AI chat that referred to the item
shows it missing.

## Folders shared with you

Something in a folder another user shares with you to edit is theirs, so deleting it moves it to
**their** Trash, at its place in their files, and the delete dialog says so. You have nothing of
it in your Trash and cannot restore or purge it; your history records the delete, and the owner
finds it on their Trash page, restores it into the shared folder or deletes it permanently: the
row is theirs, with the path in their files it was deleted from. What the owner kept by path goes
with it; what you kept, your own tags and favorites on it, ends.

Changing **Days in Trash** takes an administrator: the setup owner, or a user made
administrator under **System > Users**.

## Upgrading from a Trash with settings

Earlier versions kept Trash settings per storage: a switch, a folder and a retention in hours
that fdrive never acted on. They are gone; nothing reads the old settings.

- Trash is on for everyone, at `/.trash`. A folder already named `.trash` at the top of a home
  becomes Trash: fdrive no longer lists it, and only what fdrive put in it shows on the Trash
  page.
- An hour after the first start, Trash deletes what it has kept longer than 30 days. Set
  **Days in Trash** within that hour, or restore what you want before upgrading, to keep older
  items.
- Earlier versions kept Trash's items in one nested layout, and FDrive for Mac once kept a
  Trash of its own. v0.7.0-rc.11 moves both into Trash when it starts; later versions no longer
  do. An installation on an earlier version starts v0.7.0-rc.11 once, until it serves, before
  it updates past it. What that start could not move stays on disk and is no longer Trash's,
  and the nested layout a Trash kept in another folder is an ordinary folder now.
