import { describe, expect, it } from "vitest";
import {
  dayCountLabel,
  deleteDialogCopy,
  emptiedToastMessage,
  emptyTrashConfirmDescription,
  itemCountLabel,
  originalFolderLabel,
  purgeConfirmDescription,
  purgedToastMessage,
  restoreConflictMessage,
  restoredToastMessage,
  retentionNote,
} from "./format";

describe("originalFolderLabel", () => {
  it("returns the parent path for a nested entry", () => {
    expect(originalFolderLabel("/docs/sub/a.txt")).toBe("/docs/sub");
  });

  it("returns Home for a top-level entry", () => {
    expect(originalFolderLabel("/top.txt")).toBe("Home");
  });
});

describe("deleteDialogCopy", () => {
  it("moves to Trash, quoting the single entry's name and when Trash deletes it", () => {
    expect(deleteDialogCopy([{ name: "a.txt" }], 30)).toEqual({
      title: "Move to Trash?",
      description:
        '"a.txt" will be moved to Trash. Items in Trash are deleted permanently after 30 days.',
      confirmLabel: "Move to Trash",
      pendingLabel: "Moving to Trash…",
    });
  });

  it("summarizes multiple items by count, and says one day in the singular", () => {
    expect(deleteDialogCopy([{ name: "a.txt" }, { name: "b.txt" }], 1).description).toBe(
      "2 items will be moved to Trash. Items in Trash are deleted permanently after 1 day.",
    );
  });

  it("leaves out when Trash deletes items until the setting has loaded", () => {
    expect(deleteDialogCopy([{ name: "a.txt" }], undefined).description).toBe(
      '"a.txt" will be moved to Trash.',
    );
  });

  it("names the owner whose Trash takes what is in a folder shared with the login", () => {
    expect(deleteDialogCopy([{ name: "a.txt", owner: "alice" }], undefined).description).toBe(
      '"a.txt" will be moved to alice\'s Trash.',
    );
    expect(
      deleteDialogCopy(
        [
          { name: "a.txt", owner: "alice" },
          { name: "b.txt", owner: "alice" },
        ],
        undefined,
      ).description,
    ).toBe("2 items will be moved to alice's Trash.");
    expect(
      deleteDialogCopy([{ name: "a.txt", owner: "alice" }, { name: "mine.txt" }], 30).description,
    ).toBe(
      "2 items will be moved to Trash. Items in folders shared with you go to their owner's Trash. Items in Trash are deleted permanently after 30 days.",
    );
  });
});

describe("retentionNote", () => {
  it("says when Trash deletes what it holds, once known", () => {
    expect(retentionNote(7)).toBe("Items in Trash are deleted permanently after 7 days.");
    expect(retentionNote(undefined)).toBeNull();
    expect(dayCountLabel(1)).toBe("1 day");
  });
});

describe("itemCountLabel", () => {
  it("uses the singular for one item", () => {
    expect(itemCountLabel(1)).toBe("1 item");
  });

  it("uses the plural otherwise", () => {
    expect(itemCountLabel(0)).toBe("0 items");
    expect(itemCountLabel(3)).toBe("3 items");
  });
});

describe("restoredToastMessage", () => {
  it("names a single restored item", () => {
    expect(restoredToastMessage(1)).toBe("Restored 1 item.");
  });

  it("counts multiple restored items", () => {
    expect(restoredToastMessage(2)).toBe("Restored 2 items.");
  });
});

describe("purgedToastMessage", () => {
  it("names a single deleted item", () => {
    expect(purgedToastMessage(1)).toBe("Deleted 1 item permanently.");
  });

  it("counts multiple deleted items", () => {
    expect(purgedToastMessage(2)).toBe("Deleted 2 items permanently.");
  });
});

describe("emptiedToastMessage", () => {
  it("counts the removed items", () => {
    expect(emptiedToastMessage(5)).toBe("Trash emptied. 5 items removed permanently.");
  });

  it("uses the singular for one item", () => {
    expect(emptiedToastMessage(1)).toBe("Trash emptied. 1 item removed permanently.");
  });
});

describe("emptyTrashConfirmDescription", () => {
  it("names how many entries will be removed", () => {
    expect(emptyTrashConfirmDescription(4)).toBe(
      "This will permanently delete 4 items in Trash. This cannot be undone.",
    );
  });
});

describe("purgeConfirmDescription", () => {
  it("names the selection", () => {
    expect(purgeConfirmDescription(1)).toBe(
      "1 item will be permanently deleted. This cannot be undone.",
    );
  });
});

describe("restoreConflictMessage", () => {
  it("names the conflicting file", () => {
    expect(restoreConflictMessage("a.txt")).toBe(
      'Could not restore "a.txt": a file already exists at that location.',
    );
  });
});
