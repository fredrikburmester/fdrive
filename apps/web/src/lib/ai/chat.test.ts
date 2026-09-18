import type { Chat } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  applyLabel,
  chatStatusLabel,
  hrefForPath,
  isThinking,
  knownPaths,
  linkifyPaths,
  pendingActions,
  proposalPaths,
  userText,
} from "./chat";

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "c1",
    title: "t",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    lastMessageAt: "2026-09-18T10:00:00.000Z",
    state: "idle",
    share: { contents: true, otherFileNames: true },
    references: [],
    messages: [],
    ...patch,
  };
}

const move = {
  kind: "move" as const,
  summary: "s",
  suggestions: [
    {
      path: "/Inbox/a.txt",
      kind: "file" as const,
      destination: "/Docs",
      target: "/Docs/a.txt",
      reason: "r",
      newFolder: false,
      conflict: false,
    },
  ],
  unchanged: [],
};

describe("hrefForPath", () => {
  it("opens folders and reveals files in their folder", () => {
    expect(hrefForPath("/Docs", "dir")).toBe("/files/Docs");
    expect(hrefForPath("/Docs/a.txt", "file")).toBe("/files/Docs?select=a.txt");
    expect(hrefForPath("/Docs/a.txt")).toBe("/files/Docs?select=a.txt");
    expect(hrefForPath("/Docs/notes")).toBe("/files/Docs/notes");
    expect(hrefForPath("/", "file")).toBe("/files");
  });
});

describe("linkifyPaths", () => {
  const known = new Set(["/Inbox/a.txt", "/Docs", "/Docs/readme.md"]);

  it("links known paths and leaves unknown ones, links and code alone", () => {
    expect(linkifyPaths("See /Inbox/a.txt and /Other/x.txt.", known)).toBe(
      "See [/Inbox/a.txt](/files/Inbox?select=a.txt) and /Other/x.txt.",
    );
    expect(linkifyPaths("Folder: /Docs (two files).", known)).toBe(
      "Folder: [/Docs](/files/Docs) (two files).",
    );
    expect(linkifyPaths("`/Docs` and [x](/Docs) stay", known)).toBe("`/Docs` and [x](/Docs) stay");
    expect(linkifyPaths("```\n/Docs\n```\n/Docs", known)).toBe(
      "```\n/Docs\n```\n[/Docs](/files/Docs)",
    );
    expect(linkifyPaths("Nothing here", new Set())).toBe("Nothing here");
  });
});

describe("knownPaths", () => {
  it("collects references, attachments, card items and paths in tool results", () => {
    const paths = knownPaths(
      chat({
        references: [{ path: "/Inbox/a.txt", missing: false }],
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ kind: "text", text: "hi" }],
            references: ["/Inbox"],
            location: "/",
            createdAt: "2026-09-18T10:00:00.000Z",
          },
          {
            id: "m2",
            role: "assistant",
            parts: [
              {
                kind: "tool",
                id: "t",
                name: "list_folder",
                activity: "",
                input: "{}",
                output: "/Inbox: 2 entries\nnotes.txt (1 B, 2024-01-01)\n/Archive/old.pdf.",
                state: "done",
              },
              { kind: "action", id: "a", state: "pending", proposal: move },
              {
                kind: "action",
                id: "b",
                state: "pending",
                proposal: {
                  kind: "trash",
                  summary: "",
                  items: [{ path: "/Inbox/b.txt", kind: "file", reason: "" }],
                },
              },
              {
                kind: "action",
                id: "c",
                state: "pending",
                proposal: {
                  kind: "write",
                  summary: "",
                  path: "/Inbox/new.md",
                  mode: "create",
                  text: "",
                  expectedSha256: null,
                },
              },
            ],
            references: [],
            location: null,
            createdAt: "2026-09-18T10:00:00.000Z",
          },
        ],
      }),
    );
    expect([...paths].sort()).toEqual([
      "/Archive/old.pdf",
      "/Docs",
      "/Docs/a.txt",
      "/Inbox",
      "/Inbox/a.txt",
      "/Inbox/b.txt",
      "/Inbox/new.md",
    ]);
    expect(proposalPaths(move)).toEqual(["/Inbox/a.txt", "/Docs", "/Docs/a.txt"]);
  });
});

describe("labels and states", () => {
  it("describes chat states and apply buttons", () => {
    expect(chatStatusLabel("running")).toBe("Answering…");
    expect(chatStatusLabel("awaiting_approval")).toBe("Waiting for you");
    expect(chatStatusLabel("closed")).toBe("This chat is full");
    expect(chatStatusLabel("idle")).toBeNull();
    expect(applyLabel(move, 2)).toBe("Move 2 items");
    expect(applyLabel({ kind: "trash", summary: "", items: [] }, 1)).toBe("Trash 1 item");
    expect(
      applyLabel(
        {
          kind: "write",
          summary: "",
          path: "/a.md",
          mode: "create",
          text: "",
          expectedSha256: null,
        },
        1,
      ),
    ).toBe("Create file");
    expect(
      applyLabel(
        {
          kind: "write",
          summary: "",
          path: "/a.md",
          mode: "replace",
          text: "",
          expectedSha256: "x",
        },
        1,
      ),
    ).toBe("Replace file");
  });

  it("finds pending cards only on the last assistant message", () => {
    const pending = { kind: "action" as const, id: "a", state: "pending" as const, proposal: move };
    const assistant = (parts: Chat["messages"][number]["parts"]) => ({
      id: "m",
      role: "assistant" as const,
      parts,
      references: [],
      location: null,
      createdAt: "2026-09-18T10:00:00.000Z",
    });
    const user = {
      id: "u",
      role: "user" as const,
      parts: [
        { kind: "text" as const, text: "Hello" },
        { kind: "error" as const, message: "x" },
      ],
      references: [],
      location: null,
      createdAt: "2026-09-18T10:00:00.000Z",
    };
    expect(
      pendingActions(
        chat({ messages: [assistant([pending, { ...pending, id: "b", state: "applied" }])] }),
      ),
    ).toEqual([pending]);
    expect(pendingActions(chat({ messages: [assistant([pending]), user] }))).toEqual([]);
    expect(pendingActions(chat())).toEqual([]);
    expect(userText(user.parts)).toBe("Hello");
    expect(isThinking(chat({ state: "running", messages: [user, assistant([])] }))).toBe(true);
    expect(
      isThinking(
        chat({ state: "running", messages: [user, assistant([{ kind: "text", text: "a" }])] }),
      ),
    ).toBe(false);
    expect(isThinking(chat({ state: "idle", messages: [user, assistant([])] }))).toBe(false);
  });
});
