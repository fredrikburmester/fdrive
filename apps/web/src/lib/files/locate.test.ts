import { ApiClientError, type FsEntry } from "@fdrive/contracts";
import { baseName, parentPath } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { locatePath } from "./locate";

function entry(path: string, kind: FsEntry["kind"]): FsEntry {
  return {
    name: baseName(path),
    path,
    kind,
    size: 0,
    modifiedAt: "2026-09-18T10:00:00.000Z",
    ext: "",
    mime: null,
  };
}

/** A drive holding `entries`, answering like the API: `not_found` for anything else. */
function drive(entries: FsEntry[]) {
  return {
    stat: vi.fn(async (path: string) => {
      const found = entries.find((item) => item.path === path);
      if (found === undefined) throw new ApiClientError("not_found", "Not found.", 404);
      return found;
    }),
    list: vi.fn(async (path: string) => ({
      path,
      entries: entries.filter((item) => item.path !== "/" && parentPath(item.path) === path),
    })),
  };
}

// macOS spells "ä" and "ö" as a letter plus a combining mark.
const stored = "/Work/Västervik Energi";

describe("locatePath", () => {
  const client = drive([
    entry("/Work", "dir"),
    entry(stored, "dir"),
    entry(`${stored}/avtal.pdf`, "file"),
    entry("/Work/notes", "file"),
  ]);

  it("answers an exact path with one stat", async () => {
    await expect(locatePath(client, "/Work/notes")).resolves.toEqual({
      path: "/Work/notes",
      kind: "file",
    });
    await expect(locatePath(client, "/")).resolves.toEqual({ path: "/", kind: "dir" });
  });

  it("finds a name whose accents are encoded differently, at any depth", async () => {
    await expect(locatePath(client, "/Work/Västervik Energi")).resolves.toEqual({
      path: stored,
      kind: "dir",
    });
    await expect(locatePath(client, "/Work/Västervik Energi/avtal.pdf")).resolves.toEqual({
      path: `${stored}/avtal.pdf`,
      kind: "file",
    });
  });

  it("returns null when nothing is there, without listing inside a file", async () => {
    await expect(locatePath(client, "/Norrköping Airport")).resolves.toBeNull();
    client.list.mockClear();
    await expect(locatePath(client, "/Work/notes/inner")).resolves.toBeNull();
    expect(client.list).not.toHaveBeenCalled();
  });

  it("passes on errors other than not found", async () => {
    const failing = {
      stat: vi.fn(async () => {
        throw new ApiClientError("upstream_unavailable", "Down.", 503);
      }),
      list: vi.fn(),
    };
    await expect(locatePath(failing, "/Work")).rejects.toThrow("Down.");
  });
});
