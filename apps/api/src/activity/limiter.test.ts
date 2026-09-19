import { expect, it } from "vitest";
import { createActivityLimiter } from "./limiter.js";

it("bounds each account independently, fails closed at capacity and releases expired windows", () => {
  let now = new Date();
  const limit = createActivityLimiter(2, () => now, 2);
  limit("alice");
  limit("alice");
  expect(() => limit("alice")).toThrow("Too many");
  limit("bob");
  expect(() => limit("charlie")).toThrow("busy");
  now = new Date(now.getTime() + 60_000);
  limit("alice");
  limit("charlie");
  expect(() => limit("bob")).toThrow("busy");
  expect(() => createActivityLimiter(1)("account")).not.toThrow();
});
