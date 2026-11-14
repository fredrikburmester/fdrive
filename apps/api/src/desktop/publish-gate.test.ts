import { expect, it } from "vitest";
import { missingPublishGates } from "./publish-gate.js";

it("publishes once fdrive serializes its own writers, and never without", () => {
  expect(missingPublishGates(true)).toEqual([]);
  expect(missingPublishGates(false)).toEqual(["publish_lock"]);
});
