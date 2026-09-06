import { describe, expect, it } from "vitest";
import { escapeLikePattern, toScopeClauses } from "./index-queries.js";

describe("toScopeClauses", () => {
  it("returns an empty array for no prefixes", () => {
    expect(toScopeClauses([])).toEqual([]);
  });

  it("maps the root prefix '/' to an empty relative prefix", () => {
    expect(toScopeClauses([{ rootId: 1, fsPrefix: "/" }])).toEqual([
      { rootId: 1, relativePrefix: "" },
    ]);
  });

  it("strips the leading slash from a subtree prefix", () => {
    expect(toScopeClauses([{ rootId: 1, fsPrefix: "/alice" }])).toEqual([
      { rootId: 1, relativePrefix: "alice" },
    ]);
  });

  it("strips a leading slash from a nested prefix, keeping inner slashes", () => {
    expect(toScopeClauses([{ rootId: 2, fsPrefix: "/alice/photos" }])).toEqual([
      { rootId: 2, relativePrefix: "alice/photos" },
    ]);
  });

  it("maps every prefix in the input, in order", () => {
    expect(
      toScopeClauses([
        { rootId: 1, fsPrefix: "/alice" },
        { rootId: 2, fsPrefix: "/" },
      ]),
    ).toEqual([
      { rootId: 1, relativePrefix: "alice" },
      { rootId: 2, relativePrefix: "" },
    ]);
  });
});

describe("escapeLikePattern", () => {
  it("leaves a plain string untouched", () => {
    expect(escapeLikePattern("alice")).toBe("alice");
  });

  it("escapes a percent sign", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
  });

  it("escapes an underscore", () => {
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("escapes backslashes before escaping the characters they would otherwise double-escape", () => {
    expect(escapeLikePattern("100%_off\\")).toBe("100\\%\\_off\\\\");
  });
});
