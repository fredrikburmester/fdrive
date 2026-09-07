import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type ConnInfoLike,
  clientIpFromForwardedFor,
  extractClientIp,
  parseForwardedForEntries,
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

describe("parseForwardedForEntries", () => {
  it("returns an empty array for an undefined header", () => {
    expect(parseForwardedForEntries(undefined)).toEqual([]);
  });

  it("returns an empty array for an empty header", () => {
    expect(parseForwardedForEntries("")).toEqual([]);
  });

  it("splits on commas and trims whitespace", () => {
    expect(parseForwardedForEntries(" 1.2.3.4 , 5.6.7.8")).toEqual(["1.2.3.4", "5.6.7.8"]);
  });

  it("drops empty entries from stray commas", () => {
    expect(parseForwardedForEntries("1.2.3.4,,5.6.7.8,")).toEqual(["1.2.3.4", "5.6.7.8"]);
  });

  it("returns an empty array for a whitespace-only header", () => {
    expect(parseForwardedForEntries("   ")).toEqual([]);
  });
});

describe("clientIpFromForwardedFor", () => {
  it("returns undefined when hops is 0, ignoring the header entirely", () => {
    expect(clientIpFromForwardedFor(["1.2.3.4", "5.6.7.8"], 0)).toBeUndefined();
  });

  it("returns undefined when hops is negative", () => {
    expect(clientIpFromForwardedFor(["1.2.3.4"], -1)).toBeUndefined();
  });

  it("returns the last entry for hops = 1", () => {
    expect(clientIpFromForwardedFor(["9.9.9.9", "1.2.3.4"], 1)).toBe("1.2.3.4");
  });

  it("returns the n-th entry from the right for hops > 1", () => {
    expect(clientIpFromForwardedFor(["a", "b", "c", "d"], 2)).toBe("c");
  });

  it("returns undefined when there are fewer entries than hops (header cannot be trusted)", () => {
    expect(clientIpFromForwardedFor(["1.2.3.4"], 2)).toBeUndefined();
  });

  it("returns the sole entry when hops equals the entry count", () => {
    expect(clientIpFromForwardedFor(["1.2.3.4"], 1)).toBe("1.2.3.4");
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
