import { describe, expect, it } from "vitest";
import { filenameScore, fuseRankings } from "./ranking.ts";

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
