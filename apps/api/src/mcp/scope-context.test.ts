import type { Scope } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import {
  narrowScopePrefixes,
  reservedExclusionOf,
  resolveScopeContext,
  virtualPathFor,
} from "./scope-context.js";

const ALICE_HOME_SCOPES: readonly Scope[] = [{ fsPrefix: "/alice", virtualPrefix: "/" }];

function context(scopes: readonly Scope[] = ALICE_HOME_SCOPES) {
  const ctx = resolveScopeContext(scopes);
  if (ctx === null) throw new Error("expected a scope context");
  return ctx;
}

describe("resolveScopeContext", () => {
  it("returns null for an empty scope list", () => {
    expect(resolveScopeContext([])).toBeNull();
  });

  it("maps every scope to a prefix in the files folder's root", () => {
    const scopes: readonly Scope[] = [
      { fsPrefix: "/alice", virtualPrefix: "/" },
      { fsPrefix: "/bob/Photos", virtualPrefix: "/Shared with me/Photos" },
    ];
    expect(context(scopes).scopePrefixes).toEqual([
      { rootId: 1, fsPrefix: "/alice" },
      { rootId: 1, fsPrefix: "/bob/Photos" },
    ]);
  });
});

describe("virtualPathFor", () => {
  it("maps a row's path back to the caller's virtual path", () => {
    expect(virtualPathFor(context(), "alice/docs/report.pdf")).toBe("/docs/report.pdf");
  });

  it("returns null for a path outside every scope", () => {
    expect(virtualPathFor(context(), "bob/a.txt")).toBeNull();
  });

  it("returns null for a path a shared folder shadows (round trip fails)", () => {
    const ctx = context([
      { fsPrefix: "/alice", virtualPrefix: "/" },
      { fsPrefix: "/bob/team", virtualPrefix: "/Shared with me/team" },
    ]);
    // "alice/Shared with me/team/x.txt" maps forward to the shared folder's
    // virtual path, which resolves back to bob's folder instead.
    expect(virtualPathFor(ctx, "alice/Shared with me/team/x.txt")).toBeNull();
    expect(virtualPathFor(ctx, "bob/team/x.txt")).toBe("/Shared with me/team/x.txt");
  });

  it("returns null in the Trash and for the Trash itself", () => {
    const ctx = context();
    expect(virtualPathFor(ctx, "alice/.trash/report.pdf/168176641123456789")).toBeNull();
    expect(virtualPathFor(ctx, "alice/.trash")).toBeNull();
    expect(virtualPathFor(ctx, "alice/docs/report.pdf")).toBe("/docs/report.pdf");
  });
});

describe("reservedExclusionOf", () => {
  it("leaves out fdrive's own folders and the home's own Shared with me", () => {
    expect(reservedExclusionOf(context())).toEqual({
      prefixes: [
        { rootId: 1, fsPrefix: "/alice/.trash" },
        { rootId: 1, fsPrefix: "/alice/.fdrive-desktop" },
        { rootId: 1, fsPrefix: "/alice/Shared with me" },
      ],
    });
  });
});

describe("narrowScopePrefixes", () => {
  it("returns every scope prefix unchanged when no prefix is given", () => {
    expect(narrowScopePrefixes(context(), undefined)).toEqual([{ rootId: 1, fsPrefix: "/alice" }]);
  });

  it("narrows to the single folder a virtual path prefix resolves to", () => {
    expect(narrowScopePrefixes(context(), "/docs")).toEqual([
      { rootId: 1, fsPrefix: "/alice/docs" },
    ]);
  });

  it("returns null for a prefix outside every scope", () => {
    const ctx = context([{ fsPrefix: "/alice", virtualPrefix: "/only" }]);
    expect(narrowScopePrefixes(ctx, "/elsewhere")).toBeNull();
  });
});
