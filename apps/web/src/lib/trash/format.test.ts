import { describe, expect, it } from "vitest";
import {
  deleteDialogCopy,
  emptiedToastMessage,
  emptyTrashConfirmDescription,
  itemCountLabel,
  originalFolderLabel,
  purgeConfirmDescription,
  purgedToastMessage,
  restoreConflictMessage,
  restoredToastMessage,
  retentionDaysLabel,
  retentionNote,
  trashAvailabilityFor,
} from "./format";

describe("originalFolderLabel", () => {
  it("returns the parent path for a nested entry", () => {
    expect(originalFolderLabel("/docs/sub/a.txt")).toBe("/docs/sub");
  });

  it("returns Home for a top-level entry", () => {
    expect(originalFolderLabel("/top.txt")).toBe("Home");
  });
});

describe("retentionDaysLabel", () => {
  it("formats a whole number of days without a decimal", () => {
    expect(retentionDaysLabel(48)).toBe("2 days");
  });

  it("uses the singular for exactly one day", () => {
    expect(retentionDaysLabel(24)).toBe("1 day");
  });

  it("rounds to at most one decimal place", () => {
    expect(retentionDaysLabel(36)).toBe("1.5 days");
  });

  it("rounds a value that would otherwise need two decimals", () => {
    expect(retentionDaysLabel(20)).toBe("0.8 days");
  });

  it("uses the plural below one day", () => {
    expect(retentionDaysLabel(12)).toBe("0.5 days");
  });
});

describe("retentionNote", () => {
  it("is null when retention is not configured", () => {
    expect(retentionNote(null)).toBeNull();
  });

  it("states the configured retention in days", () => {
    expect(retentionNote(72)).toBe("Items in Trash are removed automatically after 3 days.");
  });
});

describe("deleteDialogCopy", () => {
  it("uses the permanent-delete copy when trash is null", () => {
    expect(deleteDialogCopy(["a.txt"], null)).toEqual({
      title: "Delete item?",
      description: '"a.txt" will be permanently deleted. This cannot be undone.',
      confirmLabel: "Delete",
    });
  });

  it("uses the permanent-delete copy when trash is unavailable", () => {
    expect(deleteDialogCopy(["a.txt"], { available: false, retentionHours: null })).toEqual({
      title: "Delete item?",
      description: '"a.txt" will be permanently deleted. This cannot be undone.',
      confirmLabel: "Delete",
    });
  });

  it("pluralizes the permanent-delete copy for multiple items", () => {
    expect(deleteDialogCopy(["a.txt", "b.txt"], null)).toEqual({
      title: "Delete items?",
      description: "2 items will be permanently deleted. This cannot be undone.",
      confirmLabel: "Delete",
    });
  });

  it("uses the move-to-trash copy, quoting the single entry's name, when trash is available", () => {
    expect(deleteDialogCopy(["a.txt"], { available: true, retentionHours: null })).toEqual({
      title: "Move to Trash?",
      description: '"a.txt" will be moved to Trash.',
      confirmLabel: "Move to Trash",
    });
  });

  it("summarizes multiple items by count for the move-to-trash copy", () => {
    expect(deleteDialogCopy(["a.txt", "b.txt"], { available: true, retentionHours: null })).toEqual(
      {
        title: "Move to Trash?",
        description: "2 items will be moved to Trash.",
        confirmLabel: "Move to Trash",
      },
    );
  });

  it("appends the retention note when configured", () => {
    expect(deleteDialogCopy(["a.txt"], { available: true, retentionHours: 24 })).toEqual({
      title: "Move to Trash?",
      description:
        '"a.txt" will be moved to Trash. Items in Trash are removed automatically after 1 day.',
      confirmLabel: "Move to Trash",
    });
  });

  it("treats an undefined trash argument as unavailable", () => {
    expect(deleteDialogCopy(["a.txt"], undefined).confirmLabel).toBe("Delete");
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

describe("trashAvailabilityFor", () => {
  it("follows the login's trash capability and keeps only the retention note from the status", () => {
    expect(trashAvailabilityFor({ trash: true }, { retentionHours: 48 })).toEqual({
      available: true,
      retentionHours: 48,
    });
    expect(trashAvailabilityFor({ trash: true }, undefined)).toEqual({
      available: true,
      retentionHours: null,
    });
    // A stale cached status cannot promise a trash the login no longer has.
    expect(trashAvailabilityFor({ trash: false }, { retentionHours: 48 })).toBeNull();
  });
});
