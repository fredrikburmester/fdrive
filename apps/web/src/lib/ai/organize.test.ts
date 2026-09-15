import type { OrganizeProposal, OrganizeSuggestion } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  groupSuggestions,
  initiallyChecked,
  itemCount,
  movesFor,
  providerLabel,
  recentSteps,
  summarizeMoves,
  undoMoves,
  withDestination,
} from "./organize";

function suggestion(path: string, destination: string, patch: Partial<OrganizeSuggestion> = {}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    kind: "file",
    destination,
    target: `${destination}/${name}`,
    reason: "",
    newFolder: false,
    conflict: false,
    ...patch,
  } satisfies OrganizeSuggestion;
}

describe("providerLabel", () => {
  it("names Anthropic and falls back to the administrator's server", () => {
    expect(providerLabel("anthropic")).toBe("Claude (Anthropic)");
    expect(providerLabel("openai_compatible")).toBe("your AI server");
    expect(providerLabel(null)).toBe("your AI server");
  });
});

describe("withDestination", () => {
  it("retargets a suggestion to an existing folder the person picked", () => {
    const original = suggestion("/inbox/a.pdf", "/Finance/New", {
      newFolder: true,
      conflict: true,
    });
    expect(withDestination(original, "/Docs")).toEqual({
      ...original,
      destination: "/Docs",
      target: "/Docs/a.pdf",
      newFolder: false,
      conflict: false,
    });
    expect(withDestination(original, "/")).toMatchObject({ target: "/a.pdf" });
    expect(withDestination(original, "/Finance/New")).toBe(original);
  });
});

describe("groupSuggestions", () => {
  it("groups by destination, largest group first, then by path", () => {
    const groups = groupSuggestions([
      suggestion("/inbox/b.jpg", "/Photos"),
      suggestion("/inbox/a.pdf", "/Finance", { newFolder: true }),
      suggestion("/inbox/c.jpg", "/Photos"),
      suggestion("/inbox/d.txt", "/Docs"),
    ]);
    expect(
      groups.map((group) => [group.destination, group.newFolder, group.suggestions.length]),
    ).toEqual([
      ["/Photos", false, 2],
      ["/Docs", false, 1],
      ["/Finance", true, 1],
    ]);
  });
});

describe("checked moves", () => {
  const proposal: OrganizeProposal = {
    summary: "",
    suggestions: [
      suggestion("/inbox/a.pdf", "/Finance"),
      suggestion("/inbox/b.pdf", "/Finance", { conflict: true }),
    ],
    unchanged: [],
  };

  it("starts with every suggestion checked except conflicts", () => {
    expect([...initiallyChecked(proposal)]).toEqual(["/inbox/a.pdf"]);
  });

  it("builds a request that creates folders, or nothing when none are checked", () => {
    expect(movesFor(proposal.suggestions, new Set(["/inbox/b.pdf"]))).toEqual({
      items: [{ path: "/inbox/b.pdf", target: "/Finance/b.pdf" }],
      createParents: true,
    });
    expect(movesFor(proposal.suggestions, new Set())).toBeNull();
  });
});

describe("summarizeMoves and undoMoves", () => {
  it("separates moved, failed and warned items and reverses the moves", () => {
    const outcome = summarizeMoves([
      { ok: true, path: "/a", target: "/x/a" },
      { ok: true, path: "/b", target: "/x/b", warning: "tags" },
      { ok: false, path: "/c", target: "/x/c", error: { kind: "conflict", message: "taken" } },
    ]);
    expect(outcome).toEqual({
      moved: [
        { path: "/a", target: "/x/a" },
        { path: "/b", target: "/x/b" },
      ],
      failed: [{ path: "/c", message: "taken" }],
      warnings: 1,
    });
    expect(undoMoves(outcome.moved)).toEqual({
      items: [
        { path: "/x/b", target: "/b" },
        { path: "/x/a", target: "/a" },
      ],
    });
    expect(undoMoves([])).toBeNull();
  });
});

describe("recentSteps", () => {
  it("keeps the latest steps with keys that survive new steps", () => {
    const steps = Array.from({ length: 10 }, (_, index) => `Step ${index}`);
    const latest = recentSteps(steps);
    expect(latest.map((step) => step.text)).toEqual(steps.slice(2));
    expect(latest[0]?.key).toBe("2:Step 2");
    expect(recentSteps([...steps, "Step 10"])[5]?.key).toBe(latest[6]?.key);
    expect(recentSteps(["Read 3 files", "Read 3 files"], 8).map((step) => step.key)).toEqual([
      "0:Read 3 files",
      "1:Read 3 files",
    ]);
  });
});

describe("itemCount", () => {
  it("pluralizes and groups thousands", () => {
    expect(itemCount(1)).toBe("1 item");
    expect(itemCount(0)).toBe("0 items");
    expect(itemCount(1200)).toBe(`${(1200).toLocaleString()} items`);
  });
});
