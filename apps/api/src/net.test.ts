import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { extractClientIp } from "./net.js";

function buildApp() {
  const app = new Hono();
  app.get("/ip", (c) => c.json({ ip: extractClientIp(c) }));
  return app;
}

describe("extractClientIp", () => {
  it("uses the first hop of x-forwarded-for", async () => {
    const app = buildApp();
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(await res.json()).toEqual({ ip: "1.2.3.4" });
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const app = buildApp();
    const res = await app.request("/ip", { headers: { "x-real-ip": "9.9.9.9" } });
    expect(await res.json()).toEqual({ ip: "9.9.9.9" });
  });

  it("falls back to x-real-ip when x-forwarded-for is empty", async () => {
    const app = buildApp();
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": "", "x-real-ip": "9.9.9.9" },
    });
    expect(await res.json()).toEqual({ ip: "9.9.9.9" });
  });

  it("falls back to unknown when neither header is present", async () => {
    const app = buildApp();
    const res = await app.request("/ip");
    expect(await res.json()).toEqual({ ip: "unknown" });
  });
});
