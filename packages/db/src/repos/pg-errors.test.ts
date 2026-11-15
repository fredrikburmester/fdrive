import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./pg-errors.js";

describe("isUniqueViolation", () => {
  it("knows a unique violation from the driver, or wrapped by Drizzle as its cause", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ message: "Failed query", cause: { code: "23505" } })).toBe(true);
  });

  it("refuses anything else", () => {
    for (const error of [
      { code: "23503" },
      { cause: { code: "23502" } },
      { cause: "23505" },
      new Error("23505"),
      "23505",
      null,
      undefined,
    ])
      expect(isUniqueViolation(error)).toBe(false);
  });
});
