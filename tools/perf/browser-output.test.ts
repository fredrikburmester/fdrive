import { expect, it } from "vitest";
import { parseBrowserOutput } from "./browser-output.js";

it("accepts measured browser outputs and rejects incomplete/nonfinite entries", () => {
  const result = {
    samplesMs: [1, 2],
    maxMounted: 20,
    verifiedCount: 10000,
    diagnostics: [{ listingRequests: 25, longTasksMs: [65] }],
  };
  expect(
    parseBrowserOutput({ browser: "chromium", results: { uiList: result } }).results.uiList,
  ).toEqual(result);
  for (const value of [
    null,
    [],
    { browser: 1 },
    { browser: "c", results: null },
    { browser: "c", results: { uiList: null } },
    ...[
      { samplesMs: null },
      { samplesMs: [NaN] },
      { samplesMs: ["x"] },
      { maxMounted: 0 },
      { maxMounted: 0.5 },
      { maxMounted: "a" },
      { verifiedCount: 5 },
    ].map((change) => ({ browser: "c", results: { uiList: { ...result, ...change } } })),
  ])
    expect(() => parseBrowserOutput(value)).toThrow();
});
