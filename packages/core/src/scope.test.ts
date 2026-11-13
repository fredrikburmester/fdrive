import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeSegment, isWithin, joinPath, normalizePath } from "./paths.ts";
import { filterInScope, type Scope, scopePrefixes, toFsPath, toVirtualPath } from "./scope.ts";

/** A home on the "files" root plus a nested shared folder from another user's home. */
const homeScopes: Scope[] = [
  { rootName: "files", fsPrefix: "/alice", virtualPrefix: "/" },
  { rootName: "files", fsPrefix: "/shared", virtualPrefix: "/Shared" },
];

describe("toFsPath", () => {
  it("maps the home virtual root", () => {
    expect(toFsPath(homeScopes, "/")).toEqual({ rootName: "files", fsPath: "/alice" });
  });

  it("maps a nested virtual path under the home scope", () => {
    expect(toFsPath(homeScopes, "/docs/report.pdf")).toEqual({
      rootName: "files",
      fsPath: "/alice/docs/report.pdf",
    });
  });

  it("picks the most specific (longest) matching scope", () => {
    expect(toFsPath(homeScopes, "/Shared/team.pdf")).toEqual({
      rootName: "files",
      fsPath: "/shared/team.pdf",
    });
  });

  it("returns null when nothing matches", () => {
    const noScopes: Scope[] = [];
    expect(toFsPath(noScopes, "/anything")).toBeNull();
  });
});

describe("toVirtualPath", () => {
  it("maps a home fs path back to the virtual root", () => {
    expect(toVirtualPath(homeScopes, "files", "/alice")).toBe("/");
  });

  it("maps a nested fs path back", () => {
    expect(toVirtualPath(homeScopes, "files", "/alice/docs/report.pdf")).toBe("/docs/report.pdf");
  });

  it("picks the most specific matching scope for the given root", () => {
    expect(toVirtualPath(homeScopes, "files", "/shared/team.pdf")).toBe("/Shared/team.pdf");
  });

  it("returns null for a different root", () => {
    expect(toVirtualPath(homeScopes, "other-root", "/alice")).toBeNull();
  });

  it("returns null for an fs path outside every scope of that root", () => {
    expect(toVirtualPath(homeScopes, "files", "/bob/docs")).toBeNull();
  });
});

describe("filterInScope", () => {
  interface IndexedFile {
    readonly id: number;
    readonly rootName: string;
    readonly fsPath: string;
  }

  const files: IndexedFile[] = [
    { id: 1, rootName: "files", fsPath: "/alice/notes.txt" },
    { id: 2, rootName: "files", fsPath: "/bob/secret.txt" },
    { id: 3, rootName: "files", fsPath: "/shared/team.pdf" },
    { id: 4, rootName: "other-root", fsPath: "/alice/notes.txt" },
  ];

  it("keeps only items within scope, paired with their virtual path", () => {
    const result = filterInScope(homeScopes, files, (f) => ({
      rootName: f.rootName,
      fsPath: f.fsPath,
    }));

    expect(result).toEqual([
      { item: files[0], virtualPath: "/notes.txt" },
      { item: files[2], virtualPath: "/Shared/team.pdf" },
    ]);
  });

  it("returns an empty array when nothing is in scope", () => {
    const result = filterInScope([], files, (f) => ({ rootName: f.rootName, fsPath: f.fsPath }));
    expect(result).toEqual([]);
  });
});

describe("scopePrefixes", () => {
  it("extracts rootName and fsPrefix pairs", () => {
    expect(scopePrefixes(homeScopes)).toEqual([
      { rootName: "files", fsPrefix: "/alice" },
      { rootName: "files", fsPrefix: "/shared" },
    ]);
  });
});

// --- Property tests -------------------------------------------------------

const safeSegmentArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[/\0]/g, "x"))
  .filter(isSafeSegment);

interface ScopeSeed {
  readonly rootName: string;
  readonly virtualSegs: readonly string[];
  readonly fsSegs: readonly string[];
}

const scopeSeedArb: fc.Arbitrary<ScopeSeed> = fc.record({
  rootName: fc.constantFrom("files", "nas"),
  virtualSegs: fc.array(safeSegmentArb, { minLength: 0, maxLength: 2 }),
  fsSegs: fc.array(safeSegmentArb, { minLength: 0, maxLength: 2 }),
});

/**
 * Builds scopes from seeds, deduplicating by virtualPrefix as a resolver
 * does, and giving every scope's fsPrefix a distinct leading segment
 * (`/scope<index>`) so that no two scopes' fsPrefix can ever be a prefix of
 * one another. That is what makes the fs side of the mapping unambiguous
 * and the round-trip property below always hold, regardless of how the
 * (independently random) virtual prefixes happen to nest.
 */
function buildScopes(seeds: readonly ScopeSeed[]): Scope[] {
  const seenVirtualPrefixes = new Set<string>();
  const scopes: Scope[] = [];
  seeds.forEach((seed, index) => {
    const virtualPrefix = seed.virtualSegs.length === 0 ? "/" : `/${seed.virtualSegs.join("/")}`;
    if (seenVirtualPrefixes.has(virtualPrefix)) {
      return;
    }
    seenVirtualPrefixes.add(virtualPrefix);
    const fsPrefix =
      seed.fsSegs.length === 0 ? `/scope${index}` : `/scope${index}/${seed.fsSegs.join("/")}`;
    scopes.push({ rootName: seed.rootName, fsPrefix, virtualPrefix });
  });
  return scopes;
}

describe("scope round-tripping (property)", () => {
  it("toVirtualPath(toFsPath(v)) round-trips for an in-scope virtual path", () => {
    fc.assert(
      fc.property(
        fc.array(scopeSeedArb, { minLength: 1, maxLength: 5 }),
        fc.nat({ max: 4 }),
        fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
        (seeds, pickIndexRaw, extraSegs) => {
          const scopes = buildScopes(seeds);
          if (scopes.length === 0) {
            return;
          }
          const scope = scopes[pickIndexRaw % scopes.length];
          if (scope === undefined) {
            return;
          }
          const virtualPath = joinPath(scope.virtualPrefix, ...extraSegs);

          const mapped = toFsPath(scopes, virtualPath);
          expect(mapped).not.toBeNull();
          if (mapped === null) {
            return;
          }

          const roundTripped = toVirtualPath(scopes, mapped.rootName, mapped.fsPath);
          expect(roundTripped).toBe(normalizePath(virtualPath));
        },
      ),
    );
  });

  it("nothing outside every fsPrefix ever maps to a virtual path", () => {
    fc.assert(
      fc.property(
        fc.array(scopeSeedArb, { minLength: 0, maxLength: 4 }),
        fc.constantFrom("files", "nas", "unknown-root"),
        fc.array(safeSegmentArb, { minLength: 1, maxLength: 3 }),
        (seeds, rootName, segs) => {
          const scopes = buildScopes(seeds);
          const candidate = `/__outside_every_scope__/${segs.join("/")}`;
          const isCovered = scopes.some(
            (scope) => scope.rootName === rootName && isWithin(scope.fsPrefix, candidate),
          );
          if (isCovered) {
            return;
          }
          expect(toVirtualPath(scopes, rootName, candidate)).toBeNull();
        },
      ),
    );
  });
});
