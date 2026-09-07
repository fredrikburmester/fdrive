import { expect, it } from "vitest";
import { alternatingPairs, drain } from "./measure.js";

it("drains full payloads and rejects failed or truncated transfers", async () => {
  expect(await drain(new Response("abc"), 3)).toBe(3);
  expect(await drain(new Response(null), 0)).toBe(0);
  await expect(drain(new Response("bad", { status: 500 }))).rejects.toThrow("500");
  await expect(drain(new Response("a"), 3)).rejects.toThrow("Incomplete");
  await expect(
    drain(
      new Response(
        new ReadableStream({
          start(c) {
            c.error(Error("stream"));
          },
        }),
      ),
    ),
  ).rejects.toThrow("stream");
});
it("alternates completed paired samples", () => {
  expect(alternatingPairs(3)).toEqual([
    ["direct", "api"],
    ["api", "direct"],
    ["direct", "api"],
  ]);
});
