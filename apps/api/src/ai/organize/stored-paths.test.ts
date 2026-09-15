import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import { createPathLocator, nameKey } from "./stored-paths.ts";

/** A name as macOS stores it: accents as separate combining marks. */
const mac = (text: string) => text.normalize("NFD");
/** A name as a model writes it: accents as single characters. */
const typed = (text: string) => text.normalize("NFC");

function drive() {
  return createMemoryStorage({
    [mac("/Work/Husarö/Kårstämma 2021.pdf")]: "k",
    "/Work/Plain/notes.txt": "n",
    "/Notes.txt": "n",
  });
}

describe("nameKey", () => {
  it("reads both encodings of an accented name the same", () => {
    expect(mac("Husarö")).not.toBe(typed("Husarö"));
    expect(nameKey(mac("Husarö"))).toBe(nameKey(typed("Husarö")));
  });
});

describe("createPathLocator", () => {
  it("answers the root without asking storage", async () => {
    const storage = drive();
    const stat = vi.spyOn(storage, "stat");

    expect(await createPathLocator(storage).locate("/")).toEqual({ path: "/", occupancy: "dir" });
    expect(stat).not.toHaveBeenCalled();
  });

  it("keeps a path that exists as written, without listing its folder", async () => {
    const storage = drive();
    const list = vi.spyOn(storage, "list");
    const { locate } = createPathLocator(storage);

    expect(await locate("/Work/Plain")).toEqual({ path: "/Work/Plain", occupancy: "dir" });
    expect(await locate("/Notes.txt")).toEqual({ path: "/Notes.txt", occupancy: "file" });
    expect(list).not.toHaveBeenCalled();
  });

  it("finds folders and files whose accents are encoded differently", async () => {
    const { locate } = createPathLocator(drive());

    expect(await locate(typed("/Work/Husarö"))).toEqual({
      path: mac("/Work/Husarö"),
      occupancy: "dir",
    });
    expect(await locate(typed("/Work/Husarö/Kårstämma 2021.pdf"))).toEqual({
      path: mac("/Work/Husarö/Kårstämma 2021.pdf"),
      occupancy: "file",
    });
  });

  it("keeps a missing name as written under its folder's stored spelling", async () => {
    const storage = drive();
    const list = vi.spyOn(storage, "list");
    const { locate } = createPathLocator(storage);

    expect(await locate(typed("/Work/Husarö/Dokument 2021/a.pdf"))).toEqual({
      path: `${mac("/Work/Husarö")}/Dokument 2021/a.pdf`,
      occupancy: "free",
    });
    expect(list.mock.calls.map(([path]) => path)).toEqual(["/Work", mac("/Work/Husarö")]);
  });

  it("prefers an entry spelled exactly as written over a look-alike", async () => {
    const storage = createMemoryStorage({
      [mac("/Husarö/Kårstämma.pdf")]: "decomposed",
      [`${mac("/Husarö")}/${typed("Kårstämma.pdf")}`]: "composed",
    });

    expect(await createPathLocator(storage).locate(typed("/Husarö/Kårstämma.pdf"))).toEqual({
      path: `${mac("/Husarö")}/${typed("Kårstämma.pdf")}`,
      occupancy: "file",
    });
  });

  it("treats a name under a file as free", async () => {
    const storage = drive();
    const list = vi.spyOn(storage, "list");

    expect(await createPathLocator(storage).locate("/Notes.txt/a.pdf")).toEqual({
      path: "/Notes.txt/a.pdf",
      occupancy: "free",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("reports what storage could not answer as unknown", async () => {
    const memory = drive();
    const storage: StorageProvider = {
      ...memory,
      stat: async (path) => {
        if (path === "/Private") throw new StorageError("forbidden", "denied");
        return memory.stat(path);
      },
      list: async (path) => {
        if (path === "/Work") throw new StorageError("upstream_unavailable", "down");
        return memory.list(path);
      },
    };
    const { locate } = createPathLocator(storage);

    expect(await locate("/Private")).toEqual({ path: "/Private", occupancy: "unknown" });
    expect(await locate(typed("/Work/Husarö"))).toEqual({
      path: typed("/Work/Husarö"),
      occupancy: "unknown",
    });
  });

  it("rejects when storage fails with something other than a storage error", async () => {
    const memory = drive();
    const statFails: StorageProvider = {
      ...memory,
      stat: async () => {
        throw new Error("socket closed");
      },
    };
    const listFails: StorageProvider = {
      ...memory,
      list: async () => {
        throw new Error("socket closed");
      },
    };

    await expect(createPathLocator(statFails).locate("/Work")).rejects.toThrow("socket closed");
    await expect(createPathLocator(listFails).locate(typed("/Work/Husarö"))).rejects.toThrow(
      "socket closed",
    );
  });

  it("asks storage about each path and folder once", async () => {
    const storage = drive();
    const stat = vi.spyOn(storage, "stat");
    const list = vi.spyOn(storage, "list");
    const { locate } = createPathLocator(storage);

    await Promise.all([
      locate(typed("/Work/Husarö/a.pdf")),
      locate(typed("/Work/Husarö/b.pdf")),
      locate(typed("/Work/Husarö/a.pdf")),
    ]);

    expect(stat.mock.calls.map(([path]) => path).sort()).toEqual(
      [
        typed("/Work/Husarö"),
        typed("/Work/Husarö/a.pdf"),
        typed("/Work/Husarö/b.pdf"),
        "/Work",
      ].sort(),
    );
    expect(list.mock.calls.map(([path]) => path).sort()).toEqual(
      ["/Work", mac("/Work/Husarö")].sort(),
    );
  });
});
