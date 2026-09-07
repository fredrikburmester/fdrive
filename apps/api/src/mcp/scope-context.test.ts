import type { Scope } from "@fdrive/core";
import type { IndexQueries } from "@fdrive/db";
import { describe, expect, it } from "vitest";
import { narrowScopePrefixes, resolveScopeContext, virtualPathFor } from "./scope-context.js";

function stubIndexQueries(
  rootIdsByName: () => Promise<Record<string, number>>,
): Pick<IndexQueries, "rootIdsByName"> {
  return { rootIdsByName };
}

const ALICE_HOME_SCOPES: readonly Scope[] = [
  { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
];

describe("resolveScopeContext", () => {
  it("returns null for an empty scope list", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      [],
      null,
    );
    expect(ctx).toBeNull();
  });

  it("returns null when none of the given scopes land on an indexed root", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({})),
      ALICE_HOME_SCOPES,
      null,
    );
    expect(ctx).toBeNull();
  });

  it("resolves the scope context for a verified scope with a matching indexed root", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      null,
    );

    expect(ctx).not.toBeNull();
    expect(ctx?.scopePrefixes).toEqual([{ rootId: 1, fsPrefix: "/alice" }]);
  });

  it("drops a scope whose root has no id in the index yet, keeping the rest", async () => {
    const scopes: readonly Scope[] = [
      { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      { rootName: "photos", fsPrefix: "/alice", virtualPrefix: "/photos" },
    ];
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      scopes,
      null,
    );

    expect(ctx?.scopePrefixes).toEqual([{ rootId: 1, fsPrefix: "/alice" }]);
  });
});

describe("virtualPathFor", () => {
  it("maps a file's (rootId, fsPath) back to the caller's virtual path", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      null,
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 1, "alice/docs/report.pdf")).toBe("/docs/report.pdf");
  });

  it("returns null for a root id not present in the context", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      null,
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 999, "alice/a.txt")).toBeNull();
  });

  it("returns null for a path outside every scope", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      null,
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 1, "bob/a.txt")).toBeNull();
  });

  it("returns null for a path a more specific override shadows (round trip fails)", async () => {
    const scopes: readonly Scope[] = [
      { rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" },
      { rootName: "sftpgo", fsPrefix: "/shared", virtualPrefix: "/vshared" },
    ];
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      scopes,
      null,
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    // "alice/vshared/x.txt" maps forward to "/vshared/x.txt", but that
    // virtual path resolves back to the override's real target
    // ("shared/x.txt"), not the original physical location: the round trip
    // fails, so this location must never be disclosed.
    expect(virtualPathFor(ctx, 1, "alice/vshared/x.txt")).toBeNull();
  });

  it("returns null for a path nested under the configured trash path", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      "/.trash",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 1, "alice/.trash/report.pdf/168176641123456789")).toBeNull();
  });

  it("returns null for a path equal to the configured trash path itself", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      "/.trash",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 1, "alice/.trash")).toBeNull();
  });

  it("still maps a path outside the trash when a trashPath is configured", async () => {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      "/.trash",
    );
    if (ctx === null) {
      throw new Error("expected a scope context");
    }

    expect(virtualPathFor(ctx, 1, "alice/docs/report.pdf")).toBe("/docs/report.pdf");
  });
});

describe("narrowScopePrefixes", () => {
  async function buildContext() {
    const ctx = await resolveScopeContext(
      stubIndexQueries(async () => ({ sftpgo: 1 })),
      ALICE_HOME_SCOPES,
      null,
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
      trashPath: null,
    };

    expect(narrowScopePrefixes(narrowScope, "/elsewhere")).toBeNull();
  });

  it("returns null when the resolved root has no id in the index yet", async () => {
    const ctx = await buildContext();
    const emptyRootIdByName = new Map<string, number>();
    const stale = { ...ctx, rootIdByName: emptyRootIdByName };

    expect(narrowScopePrefixes(stale, "/docs")).toBeNull();
  });
});
