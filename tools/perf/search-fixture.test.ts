import { expect, it } from "vitest";
import { searchDocument, TOPICS, validateVector } from "./search-fixture.js";

it("builds deterministic realistic names and repeated content templates", () => {
  expect(TOPICS).toHaveLength(32);
  expect(searchDocument(32).text).toBe(searchDocument(0).text);
  expect(searchDocument(24999).name).toMatch(/24999.txt$/);
  expect(() => searchDocument(-1)).toThrow();
  expect(() => searchDocument(0.5)).toThrow();
});
it("refuses invalid embedding dimensions and nonfinite values", () => {
  expect(validateVector(Array(384).fill(0))).toHaveLength(384);
  for (const value of [null, [], Array(384).fill(NaN), Array(384).fill("x")])
    expect(() => validateVector(value)).toThrow();
});
