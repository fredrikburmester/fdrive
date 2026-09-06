import { describe, expect, it } from "vitest";
import {
  EMPTY_TYPE_AHEAD_BUFFER,
  nextTypeAheadBuffer,
  TYPE_AHEAD_TIMEOUT_MS,
  typeAheadMatch,
} from "./type-ahead";

describe("nextTypeAheadBuffer", () => {
  it("starts a fresh query from empty", () => {
    const buffer = nextTypeAheadBuffer(EMPTY_TYPE_AHEAD_BUFFER, "r", 1000);
    expect(buffer).toEqual({ query: "r", lastTypedAt: 1000 });
  });

  it("appends within the timeout window", () => {
    const first = nextTypeAheadBuffer(EMPTY_TYPE_AHEAD_BUFFER, "r", 1000);
    const second = nextTypeAheadBuffer(first, "e", 1200);
    expect(second).toEqual({ query: "re", lastTypedAt: 1200 });
  });

  it("resets after the timeout elapses", () => {
    const first = nextTypeAheadBuffer(EMPTY_TYPE_AHEAD_BUFFER, "r", 1000);
    const second = nextTypeAheadBuffer(first, "e", 1000 + TYPE_AHEAD_TIMEOUT_MS + 1);
    expect(second).toEqual({ query: "e", lastTypedAt: 1000 + TYPE_AHEAD_TIMEOUT_MS + 1 });
  });

  it("treats exactly the timeout boundary as still continuing", () => {
    const first = nextTypeAheadBuffer(EMPTY_TYPE_AHEAD_BUFFER, "r", 1000);
    const second = nextTypeAheadBuffer(first, "e", 1000 + TYPE_AHEAD_TIMEOUT_MS);
    expect(second.query).toBe("re");
  });
});

describe("typeAheadMatch", () => {
  const names = ["Alpha", "beta", "Gamma", "delta"];

  it("returns null for an empty query", () => {
    expect(typeAheadMatch(names, "")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(typeAheadMatch([], "a")).toBeNull();
  });

  it("matches case-insensitively from the start", () => {
    expect(typeAheadMatch(names, "g")).toBe(2);
  });

  it("wraps around from the start index", () => {
    expect(typeAheadMatch(names, "a", 3)).toBe(0);
  });

  it("returns null when nothing matches", () => {
    expect(typeAheadMatch(names, "zz")).toBeNull();
  });

  it("normalizes an out-of-range start index", () => {
    expect(typeAheadMatch(names, "b", -1)).toBe(1);
  });
});
