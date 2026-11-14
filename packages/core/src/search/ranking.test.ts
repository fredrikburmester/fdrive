import { describe, expect, it } from "vitest";
import {
  filenameScore,
  fuseRankings,
  NAME_MATCH_BOOST,
  nameMatch,
  RECENCY_FLOOR,
  RECENCY_HALF_LIFE_DAYS,
  recencyWeight,
  typoBudget,
} from "./ranking.ts";

describe("fuseRankings", () => {
  it("returns an empty array for no lists", () => {
    expect(fuseRankings([])).toEqual([]);
  });

  it("returns an empty array when every list is empty", () => {
    expect(fuseRankings([[], []])).toEqual([]);
  });

  it("scores a single list by 1/(k+rank)", () => {
    const result = fuseRankings([[{ id: "a" }, { id: "b" }]], 60);
    expect(result).toEqual([
      { id: "a", score: 1 / 61, snippets: [] },
      { id: "b", score: 1 / 62, snippets: [] },
    ]);
  });

  it("sums scores for an id appearing in more than one list", () => {
    const result = fuseRankings(
      [
        [{ id: "a" }, { id: "b" }],
        [{ id: "b" }, { id: "a" }],
      ],
      60,
    );
    const byId = new Map(result.map((r) => [r.id, r.score]));
    expect(byId.get("a")).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(byId.get("b")).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("does not double-count a repeated id within the same list", () => {
    const result = fuseRankings([[{ id: "a" }, { id: "a" }, { id: "b" }]], 60);
    const byId = new Map(result.map((r) => [r.id, r.score]));
    expect(byId.get("a")).toBeCloseTo(1 / 61, 10);
    expect(byId.get("b")).toBeCloseTo(1 / 62, 10);
  });

  it("sorts results by score descending", () => {
    const result = fuseRankings([[{ id: "low" }, { id: "high" }]]);
    // "high" ranks first in the list so it scores higher; after fusion the
    // output order must reflect score, not the input list order.
    const swapped = fuseRankings([[{ id: "high" }, { id: "low" }]]);
    expect(swapped.map((r) => r.id)).toEqual(["high", "low"]);
    expect(result.map((r) => r.id)).toEqual(["low", "high"]);
  });

  it("keeps first-seen order as a stable tiebreak for equal scores", () => {
    const result = fuseRankings([[{ id: "a" }], [{ id: "b" }]], 60);
    expect(result[0]?.score).toBe(result[1]?.score);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("collects up to two snippets per id across lists", () => {
    const result = fuseRankings([
      [{ id: "a", snippet: "one" }],
      [{ id: "a", snippet: "two" }],
      [{ id: "a", snippet: "three" }],
    ]);
    expect(result).toEqual([{ id: "a", score: expect.any(Number), snippets: ["one", "two"] }]);
  });

  it("collects repeated snippets within one list up to the cap", () => {
    const result = fuseRankings([
      [
        { id: "a", snippet: "one" },
        { id: "a", snippet: "two" },
        { id: "a", snippet: "three" },
      ],
    ]);
    expect(result[0]?.snippets).toEqual(["one", "two"]);
  });

  it("leaves snippets empty when no item in any list carries one", () => {
    const result = fuseRankings([[{ id: "a" }]]);
    expect(result[0]?.snippets).toEqual([]);
  });

  it("uses the default k of 60 when not given", () => {
    const withDefault = fuseRankings([[{ id: "a" }]]);
    const explicit = fuseRankings([[{ id: "a" }]], 60);
    expect(withDefault).toEqual(explicit);
  });
});

describe("filenameScore", () => {
  it("matches filesai's formula for a full match at rank 1", () => {
    // (0.6 + 0.4 * 2/2) * 1.5 / (60 + 1) = 1.0 * 1.5 / 61
    expect(filenameScore(2, 2, 1, 60)).toBeCloseTo((1.0 * 1.5) / 61, 10);
  });

  it("scores a partial word match lower than a full one at the same rank", () => {
    const partial = filenameScore(1, 2, 1, 60);
    const full = filenameScore(2, 2, 1, 60);
    expect(partial).toBeLessThan(full);
  });

  it("scores a lower rank (further down the list) lower", () => {
    const rank1 = filenameScore(1, 1, 1, 60);
    const rank2 = filenameScore(1, 1, 2, 60);
    expect(rank2).toBeLessThan(rank1);
  });

  it("returns a base score of 0.6 weighting when there are no hits", () => {
    expect(filenameScore(0, 3, 1, 60)).toBeCloseTo((0.6 * 1.5) / 61, 10);
  });

  it("does not divide by zero when words is zero", () => {
    expect(filenameScore(0, 0, 1, 60)).toBeCloseTo((0.6 * 1.5) / 61, 10);
  });
});

describe("nameMatch", () => {
  const folder = "/Documents/Work/Mikrolärande";

  it("is exact when the name without its extension is the query", () => {
    expect(nameMatch("Plan mikrolärande", { name: "Plan mikrolärande.md", folder })).toBe("exact");
  });

  it("is exact when the query spells out the extension too", () => {
    expect(nameMatch("plan mikrolärande.md", { name: "Plan mikrolärande.md", folder })).toBe(
      "exact",
    );
  });

  it("ignores case and the punctuation between words", () => {
    expect(nameMatch("annual report", { name: "Annual_Report-.PDF", folder: "/" })).toBe("exact");
  });

  it("reads an accent stored as a letter plus a combining mark as the typed letter", () => {
    const name = "Plan mikrolärande.md".normalize("NFD");
    expect(nameMatch("Plan mikrolärande", { name, folder })).toBe("exact");
  });

  it("is exact for a name with no extension, and for one that starts with a dot", () => {
    expect(nameMatch("makefile", { name: "Makefile", folder: "/" })).toBe("exact");
    expect(nameMatch("env", { name: ".env", folder: "/" })).toBe("exact");
  });

  it("is words when every query word starts a word of a longer name", () => {
    expect(nameMatch("plan", { name: "Lab-3-project-planning.pdf", folder: "/uni" })).toBe("words");
    expect(nameMatch("mikro plan", { name: "Plan mikrolärande.md", folder })).toBe("words");
  });

  it("skips a one-letter query word unless the query has no others", () => {
    expect(nameMatch("plan b", { name: "Plan mikrolärande.md", folder })).toBe("words");
    expect(nameMatch("plan b", { name: "Plan B.md", folder })).toBe("exact");
    expect(nameMatch("b", { name: "Plan B.md", folder })).toBe("words");
    expect(nameMatch("b", { name: "Plan.md", folder })).toBe("none");
  });

  it("does not count a word found only inside another word", () => {
    expect(nameMatch("plan", { name: "airplane.jpg", folder: "/" })).toBe("none");
  });

  it("is path when the folders above supply the words the name lacks", () => {
    expect(nameMatch("acme invoice", { name: "invoice-03.pdf", folder: "/Clients/Acme" })).toBe(
      "path",
    );
  });

  it("is none when only the folders match", () => {
    expect(nameMatch("acme", { name: "invoice-03.pdf", folder: "/Clients/Acme" })).toBe("none");
  });

  it("is none when a word matches neither the name nor its folders", () => {
    expect(nameMatch("plan mikrolärande", { name: "Plan.md", folder: "/uni" })).toBe("none");
  });

  it("is none for a query with no words", () => {
    expect(nameMatch(" . ", { name: "Plan.md", folder: "/" })).toBe("none");
  });

  it("is typo when every word starts a word of the name give or take its typos", () => {
    expect(nameMatch("Microlär", { name: "Mikrolärande", folder: "/" })).toBe("typo");
    expect(nameMatch("mikrolarande", { name: "Mikrolärande", folder: "/" })).toBe("typo");
    expect(nameMatch("Kontextdokumnet", { name: "Kontextdokument.md", folder: "/" })).toBe("typo");
    expect(nameMatch("infragide logbok", { name: "InfraGuide loggbok", folder: "/" })).toBe("typo");
    expect(nameMatch("plan mikrolarande", { name: "Plan mikrolärande.md", folder })).toBe("typo");
  });

  it("reads an accent macOS stored decomposed the same way when counting typos", () => {
    const name = "Mötesanteckningar.pdf".normalize("NFD");
    expect(nameMatch("motesanteckningar", { name, folder: "/" })).toBe("typo");
  });

  it("allows no typo below five letters, one up to eight and two from nine", () => {
    expect(nameMatch("wrok", { name: "Work", folder: "/" })).toBe("none");
    expect(nameMatch("lagerlat", { name: "Lägerlåt.pdf", folder: "/" })).toBe("none");
    expect(nameMatch("motesantekningar", { name: "Mötesanteckningar", folder: "/" })).toBe("typo");
    expect(nameMatch("motesantekninger", { name: "Mötesanteckningar", folder: "/" })).toBe("none");
  });

  it("prefers a name and its folders spelled as typed over a typo", () => {
    expect(nameMatch("acme invoice", { name: "invoice.pdf", folder: "/Clients/Acme" })).toBe(
      "path",
    );
    expect(nameMatch("acme invoise", { name: "invoice.pdf", folder: "/Clients/Acme" })).toBe(
      "none",
    );
  });

  it("boosts each kind of match more than the one below it", () => {
    expect(NAME_MATCH_BOOST.exact).toBeGreaterThan(NAME_MATCH_BOOST.words);
    expect(NAME_MATCH_BOOST.words).toBeGreaterThan(NAME_MATCH_BOOST.path);
    expect(NAME_MATCH_BOOST.path).toBeGreaterThan(NAME_MATCH_BOOST.typo);
    expect(NAME_MATCH_BOOST.typo).toBeGreaterThan(NAME_MATCH_BOOST.none);
    expect(NAME_MATCH_BOOST.none).toBe(0);
  });
});

describe("typoBudget", () => {
  it("allows none below five letters, one up to eight and two from nine", () => {
    expect([0, 4, 5, 8, 9, 20].map(typoBudget)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("recencyWeight", () => {
  const now = new Date("2026-11-12T00:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it("is 1 for a file modified now", () => {
    expect(recencyWeight(now, now)).toBe(1);
  });

  it("counts a modification time in the future as now", () => {
    expect(recencyWeight(daysAgo(-30), now)).toBe(1);
  });

  it("has lost half of what recency adds after one half-life", () => {
    expect(recencyWeight(daysAgo(RECENCY_HALF_LIFE_DAYS), now)).toBeCloseTo(
      RECENCY_FLOOR + (1 - RECENCY_FLOOR) / 2,
      10,
    );
  });

  it("keeps falling with age but never below the floor", () => {
    const year = recencyWeight(daysAgo(365), now);
    const decade = recencyWeight(daysAgo(3650), now);
    expect(year).toBeLessThan(recencyWeight(daysAgo(30), now));
    expect(decade).toBeLessThan(year);
    expect(decade).toBeGreaterThanOrEqual(RECENCY_FLOOR);
    expect(decade).toBeCloseTo(RECENCY_FLOOR, 5);
  });

  it("cannot lift a content-only result above any name match", () => {
    // The most reciprocal rank fusion can give: first in both content lists and in the filename list.
    const bestFused = 2 / 61 + 1.5 / 61;
    expect(NAME_MATCH_BOOST.path * RECENCY_FLOOR).toBeGreaterThan(bestFused);
    expect(NAME_MATCH_BOOST.typo * RECENCY_FLOOR).toBeGreaterThan(bestFused);
  });

  it("cannot lift a typo match above a name spelled as typed, however new", () => {
    const bestFused = 2 / 61 + 1.5 / 61;
    expect(NAME_MATCH_BOOST.typo + bestFused).toBeLessThan(NAME_MATCH_BOOST.path * RECENCY_FLOOR);
  });
});
