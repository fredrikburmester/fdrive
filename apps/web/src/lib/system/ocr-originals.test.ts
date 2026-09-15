import type { OcrOriginal } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  isRestorable,
  originalTitle,
  pageSummary,
  restoreConfirmation,
  restoreOptIns,
} from "./ocr-originals";

const ORIGINAL: OcrOriginal = {
  id: "0123456789abcdef_scan.pdf",
  root: "sftpgo",
  path: "fredrik/docs/scan.pdf",
  size: 1024,
  keptAt: "2026-09-07T03:00:00+00:00",
  sha256: "a".repeat(64),
  legacy: false,
  state: "ocred",
};

describe("originalTitle", () => {
  it("names a resolved original by its source path", () => {
    expect(originalTitle(ORIGINAL)).toBe("fredrik/docs/scan.pdf");
  });

  it("falls back to the identifier when the source is unknown", () => {
    expect(originalTitle({ ...ORIGINAL, path: null })).toBe("0123456789abcdef_scan.pdf");
  });
});

describe("restoreConfirmation", () => {
  it("warns that a restore over a changed file discards those changes", () => {
    const confirmation = restoreConfirmation("changed");
    expect(confirmation.destructive).toBe(true);
    expect(confirmation.description).toContain("discards those changes");
  });

  it("warns that a restore recreates a deleted file", () => {
    const confirmation = restoreConfirmation("missing");
    expect(confirmation.destructive).toBe(true);
    expect(confirmation.title).toBe("Recreate the deleted file?");
  });

  it("does not dress up the ordinary case as destructive", () => {
    expect(restoreConfirmation("ocred").destructive).toBe(false);
    expect(restoreConfirmation(null).destructive).toBe(false);
  });

  it("says a restore over already-restored bytes changes nothing", () => {
    expect(restoreConfirmation("restored").description).toContain("changes nothing");
  });
});

describe("restoreOptIns", () => {
  it("asks for exactly the one opt-in the state needs", () => {
    expect(restoreOptIns("missing")).toEqual({
      allowRecreate: true,
      allowOverwriteChanged: false,
    });
    expect(restoreOptIns("changed")).toEqual({
      allowRecreate: false,
      allowOverwriteChanged: true,
    });
  });

  it("asks for neither in the harmless cases", () => {
    expect(restoreOptIns("ocred")).toEqual({ allowRecreate: false, allowOverwriteChanged: false });
    expect(restoreOptIns(null)).toEqual({ allowRecreate: false, allowOverwriteChanged: false });
  });
});

describe("isRestorable", () => {
  it("is false for an original whose source could not be resolved", () => {
    expect(isRestorable({ ...ORIGINAL, path: null, state: null })).toBe(false);
  });

  it("is true once a source path and state are known", () => {
    expect(isRestorable(ORIGINAL)).toBe(true);
  });
});

describe("pageSummary", () => {
  it("counts a page within the total", () => {
    expect(pageSummary(132, 25, 25)).toBe("26–50 of 132");
  });

  it("reports an empty archive without a range", () => {
    expect(pageSummary(0, 0, 0)).toBe("No kept originals");
  });
});
