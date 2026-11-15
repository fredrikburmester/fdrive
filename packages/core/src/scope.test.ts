import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeSegment, isWithin, joinPath, normalizePath } from "./paths.ts";
import { type Scope, toFsPath, toVirtualPath } from "./scope.ts";

/** A home plus a nested shared folder from another user's home. */
const homeScopes: Scope[] = [
  { fsPrefix: "/alice", virtualPrefix: "/" },
  { fsPrefix: "/shared", virtualPrefix: "/Shared" },
];

describe("toFsPath", () => {
  it("maps the home virtual root", () => {
    expect(toFsPath(homeScopes, "/")).toBe("/alice");
  });

  it("maps a nested virtual path under the home scope", () => {
    expect(toFsPath(homeScopes, "/docs/report.pdf")).toBe("/alice/docs/report.pdf");
  });

  it("picks the most specific (longest) matching scope", () => {
    expect(toFsPath(homeScopes, "/Shared/team.pdf")).toBe("/shared/team.pdf");
  });

  it("returns null when nothing matches", () => {
    const noScopes: Scope[] = [];
    expect(toFsPath(noScopes, "/anything")).toBeNull();
  });
});

describe("toVirtualPath", () => {
  it("maps a home fs path back to the virtual root", () => {
    expect(toVirtualPath(homeScopes, "/alice")).toBe("/");
  });

  it("maps a nested fs path back", () => {
    expect(toVirtualPath(homeScopes, "/alice/docs/report.pdf")).toBe("/docs/report.pdf");
  });

  it("picks the most specific matching scope", () => {
    expect(toVirtualPath(homeScopes, "/shared/team.pdf")).toBe("/Shared/team.pdf");
  });

  it("returns null for an fs path outside every scope", () => {
    expect(toVirtualPath(homeScopes, "/bob/docs")).toBeNull();
  });
});

// --- Property tests -------------------------------------------------------

const safeSegmentArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[/\0]/g, "x"))
  .filter(isSafeSegment);

interface ScopeSeed {
  readonly virtualSegs: readonly string[];
  readonly fsSegs: readonly string[];
}

const scopeSeedArb: fc.Arbitrary<ScopeSeed> = fc.record({
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
    scopes.push({ fsPrefix, virtualPrefix });
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

          const roundTripped = toVirtualPath(scopes, mapped);
          expect(roundTripped).toBe(normalizePath(virtualPath));
        },
      ),
    );
  });

  it("nothing outside every fsPrefix ever maps to a virtual path", () => {
    fc.assert(
      fc.property(
        fc.array(scopeSeedArb, { minLength: 0, maxLength: 4 }),
        fc.array(safeSegmentArb, { minLength: 1, maxLength: 3 }),
        (seeds, segs) => {
          const scopes = buildScopes(seeds);
          const candidate = `/__outside_every_scope__/${segs.join("/")}`;
          const isCovered = scopes.some((scope) => isWithin(scope.fsPrefix, candidate));
          if (isCovered) {
            return;
          }
          expect(toVirtualPath(scopes, candidate)).toBeNull();
        },
      ),
    );
  });
});
