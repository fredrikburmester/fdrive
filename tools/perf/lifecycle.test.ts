import { expect, it } from "vitest";
import { createCleanup, finishCleanup } from "./lifecycle.js";

it("cleans every acquired resource in reverse order and preserves errors", async () => {
  const c = createCleanup();
  const order: number[] = [];
  c.add(async () => {
    order.push(1);
  });
  c.add(async () => {
    order.push(2);
    throw Error("fail");
  });
  await expect(c.close()).rejects.toThrow(AggregateError);
  expect(order).toEqual([2, 1]);
  await c.close();
});

it("retains partial measurements and records cleanup failure for the artifact", async () => {
  for (const error of [new Error("cleanup broke"), "unexpected", undefined]) {
    const failures: Record<string, string> = { scenario: "original failure" };
    const observations = { list: [12, 14] };
    await finishCleanup(async () => {
      if (error !== undefined) throw error;
    }, failures);
    expect(JSON.parse(JSON.stringify({ observations, failures }))).toEqual({
      observations: { list: [12, 14] },
      failures:
        error === undefined
          ? { scenario: "original failure" }
          : {
              scenario: "original failure",
              cleanup: error instanceof Error ? "cleanup broke" : "Fixture cleanup failed",
            },
    });
  }
});
