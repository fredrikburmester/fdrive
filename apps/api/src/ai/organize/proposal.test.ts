import { StorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import type { OrganizeItem, OrganizeSubmission } from "./agent.ts";
import { buildProposal } from "./proposal.ts";

function file(path: string): OrganizeItem {
  return { path, kind: "file", size: 1, modifiedAt: null };
}

function dir(path: string): OrganizeItem {
  return { path, kind: "dir", size: 0, modifiedAt: null };
}

function drive() {
  return createMemoryStorage({
    "/Inbox/a.pdf": "a",
    "/Inbox/b.pdf": "b",
    "/Inbox/c.pdf": "c",
    "/Inbox/Photos/1.jpg": "p",
    "/Old/a.pdf": "old",
    "/Finance/Receipts/x.pdf": "x",
    "/Finance/Receipts/b.pdf": "taken",
    "/Finance/Receipts/Photos/keep.txt": "k",
    "/Notes.txt": "n",
  });
}

function submission(overrides: Partial<OrganizeSubmission> = {}): OrganizeSubmission {
  return { summary: "Tidy up.", moves: [], unchanged: [], ...overrides };
}

function move(path: string, destination: string, reason = "Fits there.") {
  return { path, destination, reason };
}

function build(input: {
  items: readonly OrganizeItem[];
  submission: OrganizeSubmission;
  storage?: StorageProvider;
  trashPath?: string | null;
}) {
  return buildProposal({
    storage: input.storage ?? drive(),
    items: input.items,
    submission: input.submission,
    trashPath: input.trashPath ?? null,
  });
}

describe("buildProposal", () => {
  it("suggests a move into an existing folder", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf")],
      submission: submission({ moves: [move("/Inbox/a.pdf", "/Finance/Receipts", "A receipt.")] }),
    });

    expect(proposal).toEqual({
      summary: "Tidy up.",
      suggestions: [
        {
          path: "/Inbox/a.pdf",
          kind: "file",
          destination: "/Finance/Receipts",
          target: "/Finance/Receipts/a.pdf",
          reason: "A receipt.",
          newFolder: false,
          conflict: false,
        },
      ],
      unchanged: [],
    });
  });

  it("marks a destination that does not exist yet as a new folder", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf")],
      submission: submission({ moves: [move("Inbox/a.pdf", "Finance/2024/")] }),
    });

    expect(proposal.suggestions).toEqual([
      expect.objectContaining({
        path: "/Inbox/a.pdf",
        destination: "/Finance/2024",
        target: "/Finance/2024/a.pdf",
        newFolder: true,
        conflict: false,
      }),
    ]);
  });

  it("flags a conflict when something already exists at the target", async () => {
    const proposal = await build({
      items: [file("/Inbox/b.pdf"), dir("/Inbox/Photos")],
      submission: submission({
        moves: [
          move("/Inbox/b.pdf", "/Finance/Receipts"),
          move("/Inbox/Photos", "/Finance/Receipts"),
        ],
      }),
    });

    expect(proposal.suggestions).toEqual([
      expect.objectContaining({ path: "/Inbox/b.pdf", newFolder: false, conflict: true }),
      expect.objectContaining({
        path: "/Inbox/Photos",
        kind: "dir",
        target: "/Finance/Receipts/Photos",
        newFolder: false,
        conflict: true,
      }),
    ]);
  });

  it("flags a conflict when the destination is a file", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf")],
      submission: submission({ moves: [move("/Inbox/a.pdf", "/Notes.txt")] }),
    });

    expect(proposal.suggestions).toEqual([
      expect.objectContaining({ target: "/Notes.txt/a.pdf", newFolder: false, conflict: true }),
    ]);
  });

  it("flags every suggestion after the first that claims the same target", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf"), file("/Old/a.pdf"), file("/Inbox/c.pdf")],
      submission: submission({
        moves: [
          move("/Inbox/a.pdf", "/Archive"),
          move("/Old/a.pdf", "/Archive"),
          move("/Inbox/c.pdf", "/Archive"),
        ],
      }),
    });

    expect(proposal.suggestions.map((s) => [s.path, s.target, s.newFolder, s.conflict])).toEqual([
      ["/Inbox/a.pdf", "/Archive/a.pdf", true, false],
      ["/Old/a.pdf", "/Archive/a.pdf", true, true],
      ["/Inbox/c.pdf", "/Archive/c.pdf", true, false],
    ]);
  });

  it("ignores moves for items that were not selected, invalid paths and repeated moves", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf")],
      submission: submission({
        moves: [
          move("/Inbox/b.pdf", "/Finance"),
          move("/bad\0path", "/Finance"),
          move("/Inbox/a.pdf", "/Finance", "First."),
          move("/Inbox/a.pdf", "/Archive", "Second."),
        ],
      }),
    });

    expect(proposal.suggestions).toEqual([
      expect.objectContaining({ path: "/Inbox/a.pdf", destination: "/Finance", reason: "First." }),
    ]);
    expect(proposal.unchanged).toEqual([]);
  });

  it("keeps an item in place when its destination is not a valid path", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf")],
      submission: submission({ moves: [move("/Inbox/a.pdf", "/Fin\0ance")] }),
    });

    expect(proposal.suggestions).toEqual([]);
    expect(proposal.unchanged).toEqual([
      { path: "/Inbox/a.pdf", reason: "The suggested folder was not a valid path." },
    ]);
  });

  it("keeps an item in place, with the model's reason, when the destination is where it already is", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf")],
      submission: submission({
        moves: [move("/Inbox/a.pdf", "/Inbox/", "  Already   in the right\nplace. ")],
      }),
    });

    expect(proposal.suggestions).toEqual([]);
    expect(proposal.unchanged).toEqual([
      { path: "/Inbox/a.pdf", reason: "Already in the right place." },
    ]);
  });

  it("keeps an item in place when the destination is in Trash", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf"), file("/Inbox/b.pdf"), file("/Inbox/c.pdf")],
      trashPath: "/.Trash",
      submission: submission({
        moves: [
          move("/Inbox/a.pdf", "/.Trash"),
          move("/Inbox/b.pdf", "/.Trash/2024"),
          move("/Inbox/c.pdf", "/.Trash-not/2024"),
        ],
      }),
    });

    expect(proposal.unchanged).toEqual([
      { path: "/Inbox/a.pdf", reason: "The suggested folder is in Trash." },
      { path: "/Inbox/b.pdf", reason: "The suggested folder is in Trash." },
    ]);
    expect(proposal.suggestions.map((s) => s.path)).toEqual(["/Inbox/c.pdf"]);
  });

  it("keeps an item in place when the destination is a selected folder or inside one", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf"), file("/Inbox/b.pdf"), dir("/Inbox/Photos")],
      submission: submission({
        moves: [
          move("/Inbox/a.pdf", "/Inbox/Photos"),
          move("/Inbox/b.pdf", "/Inbox/Photos/2024"),
          move("/Inbox/Photos", "/Media"),
        ],
      }),
    });

    expect(proposal.unchanged).toEqual([
      { path: "/Inbox/a.pdf", reason: "The suggested folder is itself part of the selection." },
      { path: "/Inbox/b.pdf", reason: "The suggested folder is itself part of the selection." },
    ]);
    expect(proposal.suggestions.map((s) => s.path)).toEqual(["/Inbox/Photos"]);
  });

  it("keeps the model's unchanged items once, ignoring ones it already moved or did not select", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf"), file("/Inbox/b.pdf")],
      submission: submission({
        moves: [move("/Inbox/a.pdf", "/Finance")],
        unchanged: [
          { path: "/Inbox/a.pdf", reason: "Contradicts the move." },
          { path: "Inbox/b.pdf", reason: "Unclear what this is." },
          { path: "/Inbox/b.pdf", reason: "Said twice." },
          { path: "/Elsewhere.pdf", reason: "Not selected." },
          { path: "/bad\0path", reason: "Invalid." },
        ],
      }),
    });

    expect(proposal.suggestions.map((s) => s.path)).toEqual(["/Inbox/a.pdf"]);
    expect(proposal.unchanged).toEqual([{ path: "/Inbox/b.pdf", reason: "Unclear what this is." }]);
  });

  it("keeps items the model did not mention, saying so", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf"), dir("/Inbox/Photos")],
      submission: submission(),
    });

    expect(proposal.suggestions).toEqual([]);
    expect(proposal.unchanged).toEqual([
      { path: "/Inbox/a.pdf", reason: "The assistant made no suggestion for this item." },
      { path: "/Inbox/Photos", reason: "The assistant made no suggestion for this item." },
    ]);
  });

  it("collapses whitespace and clips long reasons and summaries", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf"), file("/Inbox/b.pdf")],
      submission: submission({
        summary: `  ${"s".repeat(1200)}  `,
        moves: [move("/Inbox/a.pdf", "/Finance", "r".repeat(301))],
        unchanged: [{ path: "/Inbox/b.pdf", reason: "u".repeat(300) }],
      }),
    });

    expect(proposal.summary).toBe(`${"s".repeat(999)}…`);
    expect(proposal.suggestions[0]?.reason).toBe(`${"r".repeat(299)}…`);
    expect(proposal.unchanged[0]?.reason).toBe("u".repeat(300));
  });

  it("sets aside only the suggestions storage could not check", async () => {
    const memory = drive();
    const flaky: StorageProvider = {
      ...memory,
      stat: async (path) => {
        if (path === "/Private") throw new StorageError("forbidden", "denied");
        if (path === "/Finance/Receipts/c.pdf") throw new StorageError("rate_limited", "slow down");
        return memory.stat(path);
      },
    };

    const proposal = await build({
      storage: flaky,
      items: [file("/Inbox/a.pdf"), file("/Inbox/b.pdf"), file("/Inbox/c.pdf")],
      submission: submission({
        moves: [
          move("/Inbox/a.pdf", "/Private"),
          move("/Inbox/b.pdf", "/Old"),
          move("/Inbox/c.pdf", "/Finance/Receipts"),
        ],
      }),
    });

    expect(proposal.suggestions.map((suggestion) => suggestion.path)).toEqual(["/Inbox/b.pdf"]);
    expect(proposal.unchanged).toEqual([
      { path: "/Inbox/a.pdf", reason: "fdrive could not check the suggested folder." },
      { path: "/Inbox/c.pdf", reason: "fdrive could not check the suggested folder." },
    ]);
  });

  it("rejects when checking storage fails with something other than a storage error", async () => {
    const broken: StorageProvider = {
      ...drive(),
      stat: async () => {
        throw new Error("socket closed");
      },
    };

    await expect(
      build({
        storage: broken,
        items: [file("/Inbox/a.pdf")],
        submission: submission({ moves: [move("/Inbox/a.pdf", "/Finance")] }),
      }),
    ).rejects.toThrow("socket closed");
  });

  it("checks each path in storage only once", async () => {
    const storage = drive();
    const stat = vi.spyOn(storage, "stat");

    await build({
      storage,
      items: [file("/Inbox/a.pdf"), file("/Inbox/b.pdf"), file("/Inbox/c.pdf")],
      submission: submission({
        moves: [
          move("/Inbox/a.pdf", "/Archive"),
          move("/Inbox/b.pdf", "/Archive"),
          move("/Inbox/c.pdf", "/Archive"),
        ],
      }),
    });

    const paths = stat.mock.calls.map(([path]) => path);
    expect(paths.filter((path) => path === "/Archive")).toHaveLength(1);
    expect(paths.sort()).toEqual([
      "/Archive",
      "/Archive/a.pdf",
      "/Archive/b.pdf",
      "/Archive/c.pdf",
    ]);
  });

  describe("names whose accents are encoded differently", () => {
    /** As macOS stores names: accents as separate combining marks. */
    const mac = (text: string) => text.normalize("NFD");
    /** As a model writes paths: accents as single characters. */
    const typed = (text: string) => text.normalize("NFC");

    function swedishDrive() {
      return createMemoryStorage({
        [mac("/Drop/Kårstämma 2021.pdf")]: "k",
        [mac("/Drop/påskrift 2022.jpeg")]: "p",
        [mac("/Drop/Årsmöte 2023.docx")]: "a",
        [mac("/Drop/Husarö/keep.txt")]: "h",
        [mac("/Work/Husarö/Dokument 2015-2020/old.pdf")]: "o",
        [`${mac("/Work/Husarö")}/${typed("Årsmöte 2023.docx")}`]: "taken",
      });
    }

    it("matches the selection and reuses existing folders by how their names read", async () => {
      const proposal = await build({
        storage: swedishDrive(),
        items: [file(mac("/Drop/Kårstämma 2021.pdf")), file(mac("/Drop/påskrift 2022.jpeg"))],
        submission: submission({
          moves: [
            move(typed("/Drop/Kårstämma 2021.pdf"), typed("/Work/Husarö/Dokument 2021-2023")),
          ],
          unchanged: [{ path: typed("/Drop/påskrift 2022.jpeg"), reason: "Unreadable scan." }],
        }),
      });

      expect(proposal.suggestions).toEqual([
        expect.objectContaining({
          path: mac("/Drop/Kårstämma 2021.pdf"),
          destination: `${mac("/Work/Husarö")}/${typed("Dokument 2021-2023")}`,
          target: `${mac("/Work/Husarö")}/${typed("Dokument 2021-2023")}/${mac("Kårstämma 2021.pdf")}`,
          newFolder: true,
          conflict: false,
        }),
      ]);
      expect(proposal.unchanged).toEqual([
        { path: mac("/Drop/påskrift 2022.jpeg"), reason: "Unreadable scan." },
      ]);
    });

    it("flags a target that already holds a look-alike name", async () => {
      const proposal = await build({
        storage: swedishDrive(),
        items: [file(mac("/Drop/Årsmöte 2023.docx"))],
        submission: submission({
          moves: [move(typed("/Drop/Årsmöte 2023.docx"), typed("/Work/Husarö"))],
        }),
      });

      expect(proposal.suggestions).toEqual([
        expect.objectContaining({
          destination: mac("/Work/Husarö"),
          target: `${mac("/Work/Husarö")}/${mac("Årsmöte 2023.docx")}`,
          newFolder: false,
          conflict: true,
        }),
      ]);
    });

    it("recognizes the current folder and selected folders spelled differently", async () => {
      const proposal = await build({
        storage: swedishDrive(),
        items: [
          file(mac("/Work/Husarö/Dokument 2015-2020/old.pdf")),
          file(mac("/Drop/påskrift 2022.jpeg")),
          dir(mac("/Drop/Husarö")),
        ],
        submission: submission({
          moves: [
            move(
              typed("/Work/Husarö/Dokument 2015-2020/old.pdf"),
              typed("/Work/Husarö/Dokument 2015-2020"),
              "Belongs here.",
            ),
            move(typed("/Drop/påskrift 2022.jpeg"), typed("/Drop/Husarö/Scans")),
            move(typed("/Drop/Husarö"), "/Work"),
          ],
        }),
      });

      expect(proposal.unchanged).toEqual([
        { path: mac("/Work/Husarö/Dokument 2015-2020/old.pdf"), reason: "Belongs here." },
        {
          path: mac("/Drop/påskrift 2022.jpeg"),
          reason: "The suggested folder is itself part of the selection.",
        },
      ]);
      expect(proposal.suggestions.map((s) => s.path)).toEqual([mac("/Drop/Husarö")]);
    });

    it("flags a second suggestion whose target only differs in how its accents are encoded", async () => {
      const proposal = await build({
        storage: createMemoryStorage({
          [mac("/Drop/Kårstämma.pdf")]: "a",
          [typed("/Old/Kårstämma.pdf")]: "b",
        }),
        items: [file(mac("/Drop/Kårstämma.pdf")), file(typed("/Old/Kårstämma.pdf"))],
        submission: submission({
          moves: [
            move(typed("/Drop/Kårstämma.pdf"), "/Archive"),
            move(typed("/Old/Kårstämma.pdf"), "/Archive"),
          ],
        }),
      });

      expect(proposal.suggestions.map((s) => s.conflict)).toEqual([false, true]);
    });
  });

  it("says when the assistant's suggestions named paths that match no selected item", async () => {
    const proposal = await build({
      items: [file("/Inbox/a.pdf"), file("/Inbox/b.pdf")],
      submission: submission({
        moves: [move("/Inbox/b.pdf", "/Finance"), move("/Downloads/a.pdf", "/Finance")],
      }),
    });

    expect(proposal.unchanged).toEqual([
      {
        path: "/Inbox/a.pdf",
        reason: "The assistant's suggestions did not name this item's path.",
      },
    ]);
  });

  it("checks storage for many suggestions in parallel and keeps their order", async () => {
    const items = Array.from({ length: 20 }, (_, i) => file(`/Inbox/f${i}.pdf`));
    const proposal = await build({
      items,
      submission: submission({ moves: items.map((item) => move(item.path, "/Sorted")) }),
    });

    expect(proposal.suggestions.map((s) => s.path)).toEqual(items.map((item) => item.path));
    expect(proposal.suggestions.every((s) => s.newFolder && !s.conflict)).toBe(true);
  });
});
