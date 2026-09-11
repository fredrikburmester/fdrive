import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type ConnInfoLike,
  extractClientIp,
  parseForwardedEntries,
  trustedForwardedEntry,
  trustedForwardedProtoEntry,
} from "./net.js";

function buildApp(
  hops: number,
  connInfo?: (c: Parameters<typeof extractClientIp>[0]) => ConnInfoLike,
) {
  const app = new Hono();
  app.get("/ip", (c) =>
    c.json({
      ip: connInfo === undefined ? extractClientIp(c, hops) : extractClientIp(c, hops, connInfo),
    }),
  );
  return app;
}

const NO_SOCKET: (c: Parameters<typeof extractClientIp>[0]) => ConnInfoLike = () => {
  throw new Error("no socket in this test harness");
};

describe("parseForwardedEntries", () => {
  it("returns an empty array for an undefined header", () => {
    expect(parseForwardedEntries(undefined)).toEqual([]);
  });

  it("returns an empty array for an empty header", () => {
    expect(parseForwardedEntries("")).toEqual([]);
  });

  it("splits on commas and trims whitespace", () => {
    expect(parseForwardedEntries(" 1.2.3.4 , 5.6.7.8")).toEqual(["1.2.3.4", "5.6.7.8"]);
  });

  it("drops empty entries from stray commas", () => {
    expect(parseForwardedEntries("1.2.3.4,,5.6.7.8,")).toEqual(["1.2.3.4", "5.6.7.8"]);
  });

  it("returns an empty array for a whitespace-only header", () => {
    expect(parseForwardedEntries("   ")).toEqual([]);
  });
});

describe("trustedForwardedEntry", () => {
  it("returns undefined when hops is 0, ignoring the header entirely", () => {
    expect(trustedForwardedEntry(["1.2.3.4", "5.6.7.8"], 0)).toBeUndefined();
  });

  it("returns undefined when hops is negative", () => {
    expect(trustedForwardedEntry(["1.2.3.4"], -1)).toBeUndefined();
  });

  it("returns the last entry for hops = 1", () => {
    expect(trustedForwardedEntry(["9.9.9.9", "1.2.3.4"], 1)).toBe("1.2.3.4");
  });

  it("returns the n-th entry from the right for hops > 1", () => {
    expect(trustedForwardedEntry(["a", "b", "c", "d"], 2)).toBe("c");
  });

  it("returns undefined when there are fewer entries than hops (header cannot be trusted)", () => {
    expect(trustedForwardedEntry(["1.2.3.4"], 2)).toBeUndefined();
  });

  it("returns the sole entry when hops equals the entry count", () => {
    expect(trustedForwardedEntry(["1.2.3.4"], 1)).toBe("1.2.3.4");
  });
});

describe("trustedForwardedProtoEntry", () => {
  it("returns undefined when hops is 0, ignoring the header entirely", () => {
    expect(trustedForwardedProtoEntry(["https"], 0)).toBeUndefined();
  });

  it("returns undefined when hops is negative", () => {
    expect(trustedForwardedProtoEntry(["https"], -1)).toBeUndefined();
  });

  it("returns undefined when the header has no entries", () => {
    expect(trustedForwardedProtoEntry([], 2)).toBeUndefined();
  });

  it("returns the last entry for hops = 1", () => {
    expect(trustedForwardedProtoEntry(["http", "https"], 1)).toBe("https");
  });

  it("returns the n-th entry from the right for hops > 1", () => {
    expect(trustedForwardedProtoEntry(["a", "b", "c", "d"], 2)).toBe("c");
  });

  it("clamps to the leftmost entry when the chain is shorter than hops", () => {
    // Proxies replace x-forwarded-proto rather than append to it, so one
    // entry is what a two-hop deployment normally sends.
    expect(trustedForwardedProtoEntry(["https"], 2)).toBe("https");
    expect(trustedForwardedProtoEntry(["http", "https"], 5)).toBe("http");
  });

  it("differs from trustedForwardedEntry only on a chain shorter than hops", () => {
    expect(trustedForwardedEntry(["https"], 2)).toBeUndefined();
    expect(trustedForwardedProtoEntry(["https"], 2)).toBe("https");
    for (const hops of [0, 1, 2, 3]) {
      expect(trustedForwardedProtoEntry(["a", "b", "c"], hops)).toBe(
        trustedForwardedEntry(["a", "b", "c"], hops),
      );
    }
  });
});

describe("extractClientIp", () => {
  it("trusts the last hop of x-forwarded-for when hops = 1, not a forged first hop", async () => {
    const app = buildApp(1, NO_SOCKET);
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": "9.9.9.9, 1.2.3.4" },
    });
    expect(await res.json()).toEqual({ ip: "1.2.3.4" });
  });

  it("trusts the n-th hop from the right for hops > 1", async () => {
    const app = buildApp(2, NO_SOCKET);
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": "9.9.9.9, 1.2.3.4, 5.6.7.8" },
    });
    expect(await res.json()).toEqual({ ip: "1.2.3.4" });
  });

  it("ignores x-forwarded-for entirely when hops = 0 and falls back", async () => {
    const app = buildApp(0, () => ({ remote: { address: "10.0.0.1" } }));
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(await res.json()).toEqual({ ip: "10.0.0.1" });
  });

  it("falls back to the connection peer when there are fewer entries than hops", async () => {
    const app = buildApp(2, () => ({ remote: { address: "10.0.0.1" } }));
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(await res.json()).toEqual({ ip: "10.0.0.1" });
  });

  it("keeps failing closed on a short chain where the proto path clamps", async () => {
    // Every hop appends to x-forwarded-for, so fewer entries than hops
    // means the header cannot be attributed to a trusted proxy and the
    // leading entry must not be read as the client. x-forwarded-proto is
    // replaced rather than appended and so clamps instead: the two rules
    // are deliberately different and must not converge.
    const app = buildApp(2, () => ({ remote: { address: "10.0.0.1" } }));
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(await res.json()).toEqual({ ip: "10.0.0.1" });
    expect(trustedForwardedProtoEntry(["9.9.9.9"], 2)).toBe("9.9.9.9");
  });

  it("falls back to the connection peer when x-forwarded-for is absent", async () => {
    const app = buildApp(1, () => ({ remote: { address: "10.0.0.1" } }));
    const res = await app.request("/ip");
    expect(await res.json()).toEqual({ ip: "10.0.0.1" });
  });

  it("falls back to unknown when connInfo throws (no real socket)", async () => {
    const app = buildApp(1, NO_SOCKET);
    const res = await app.request("/ip");
    expect(await res.json()).toEqual({ ip: "unknown" });
  });

  it("falls back to unknown when connInfo reports no address", async () => {
    const app = buildApp(1, () => ({ remote: {} }));
    const res = await app.request("/ip");
    expect(await res.json()).toEqual({ ip: "unknown" });
  });

  it("falls back to unknown when connInfo reports an empty address", async () => {
    const app = buildApp(1, () => ({ remote: { address: "" } }));
    const res = await app.request("/ip");
    expect(await res.json()).toEqual({ ip: "unknown" });
  });

  it("uses the default getConnInfo (from @hono/node-server) when none is injected, falling back to unknown outside a real socket", async () => {
    const app = buildApp(1);
    const res = await app.request("/ip");
    expect(await res.json()).toEqual({ ip: "unknown" });
  });
});
