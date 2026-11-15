import { describe, expect, it } from "vitest";
import { LOCAL_FOLDER_NOTE, storageNameError, storageRenamePatch } from "./storage";

describe("storage copy", () => {
  it("names the variable that sets the folder", () => {
    expect(LOCAL_FOLDER_NOTE).toBe("Folder on this server, set by FDRIVE_STORAGE_ROOT.");
  });
});

describe("storageNameError", () => {
  it("accepts a name the API accepts, trimmed", () => {
    expect(storageNameError("  Home storage  ")).toBeNull();
  });

  it("refuses a blank name", () => {
    expect(storageNameError("   ")).toBe("Enter a name for this storage.");
  });

  it("refuses a name over 120 characters", () => {
    expect(storageNameError("x".repeat(121))).toBe(
      "Use 120 characters or fewer for the storage name.",
    );
  });
});

describe("storageRenamePatch", () => {
  const saved = { name: "Local folder" };

  it("sends the trimmed new name", () => {
    expect(storageRenamePatch(saved, "  Home storage ")).toEqual({ name: "Home storage" });
  });

  it("sends nothing when the name trims to the saved one", () => {
    expect(storageRenamePatch(saved, "Local folder")).toBeNull();
    expect(storageRenamePatch(saved, "  Local folder  ")).toBeNull();
  });

  it("sends nothing for a name the API would refuse", () => {
    expect(storageRenamePatch(saved, "")).toBeNull();
    expect(storageRenamePatch(saved, "x".repeat(121))).toBeNull();
  });
});
