import { parseHomeTemplate } from "@fdrive/core";
import type { IndexQueries } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { narrowScopePrefixes, resolveScopeContext, virtualPathFor } from "./scope-context.js";

function fail(name: string): never {
  throw new Error(`unexpected call to ${name} in this test`);
}

function stubIndexQueries(rootIdsByName: () => Promise<Record<string, number>>): IndexQueries {
  return {
    semantic: async () => fail("semantic"),
    fulltext: async () => fail("fulltext"),
    filename: async () => fail("filename"),
    filesByIds: async () => fail("filesByIds"),
    fileByPath: async () => fail("fileByPath"),
    listFiles: async () => fail("listFiles"),
    filesBySha256: async () => fail("filesBySha256"),
    rootIdsByName,
    stats: async () => fail("stats"),
    duplicates: async () => fail("duplicates"),
    similar: async () => fail("similar"),
    recentFiles: async () => fail("recentFiles"),
    thumbnail: async () => fail("thumbnail"),
    recordMove: async () => fail("recordMove"),
    recentMoves: async () => fail("recentMoves"),
    deletedRowSha: async () => fail("deletedRowSha"),
    liveRowsBySha: async () => fail("liveRowsBySha"),
  };
}

const TEMPLATE = parseHomeTemplate("sftpgo:/{username}");

describe("resolveScopeContext", () => {
  it("returns null when no index roots are configured", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(),
      "alice",
    );
    expect(ctx).toBeNull();
  });

  it("returns null for a username that is not a safe path segment", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(["sftpgo"]),
      "../etc",
    );
    expect(ctx).toBeNull();
  });

  it("returns null when the configured root has no matching row in the index", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({})),
      TEMPLATE,
      new Set(["sftpgo"]),
      "alice",
    );
    expect(ctx).toBeNull();
  });

  it("resolves the scope context for a valid identity and configured root", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(["sftpgo"]),
      "alice",
    );

    expect(ctx).not.toBeNull();
    expect(ctx?.scopePrefixes).toEqual([{ rootId: 1, fsPrefix: "/alice" }]);
  });
});

describe("virtualPathFor", () => {
  it("maps a file's (rootId, fsPath) back to the caller's virtual path", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(["sftpgo"]),
      "alice",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 1, "alice/docs/report.pdf")).toBe("/docs/report.pdf");
  });

  it("returns null for a root id not present in the context", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(["sftpgo"]),
      "alice",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 999, "alice/a.txt")).toBeNull();
  });

  it("returns null for a path outside every scope", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(["sftpgo"]),
      "alice",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 1, "bob/a.txt")).toBeNull();
  });
});

describe("narrowScopePrefixes", () => {
  async function buildContext() {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(["sftpgo"]),
      "alice",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }
    return ctx;
  }

  it("returns every scope prefix unchanged when no prefix is given", async () => {
    const ctx = await buildContext();
    expect(narrowScopePrefixes(ctx, undefined)).toEqual([{ rootId: 1, fsPrefix: "/alice" }]);
  });

  it("narrows to the single folder a virtual path prefix resolves to", async () => {
    const ctx = await buildContext();
    expect(narrowScopePrefixes(ctx, "/docs")).toEqual([{ rootId: 1, fsPrefix: "/alice/docs" }]);
  });

  it("returns null for a prefix outside every scope", async () => {
    const narrowScope = {
      scopes: [{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/only" }],
      scopePrefixes: [{ rootId: 1, fsPrefix: "/alice" }],
      rootNameById: new Map([[1, "sftpgo"]]),
      rootIdByName: new Map([["sftpgo", 1]]),
    };

    expect(narrowScopePrefixes(narrowScope, "/elsewhere")).toBeNull();
  });

  it("returns null when the resolved root has no id in the index yet", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      TEMPLATE,
      new Set(["sftpgo"]),
      "alice",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }
    const emptyRootIdByName = new Map<string, number>();
    const stale = { ...ctx, rootIdByName: emptyRootIdByName };

    expect(narrowScopePrefixes(stale, "/docs")).toBeNull();
  });
});
