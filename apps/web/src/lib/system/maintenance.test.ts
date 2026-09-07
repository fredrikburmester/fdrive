import { ApiClientError } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { describeMaintenanceError } from "./maintenance";

describe("describeMaintenanceError", () => {
  it("explains a busy admission response", () => {
    expect(describeMaintenanceError(new ApiClientError("conflict", "busy", 409))).toBe(
      "A maintenance job is already running. Wait for it to finish, then try again.",
    );
  });
  it("retains standard API failure guidance", () => {
    expect(describeMaintenanceError(new ApiClientError("forbidden", "denied", 403))).toBe(
      "You don't have permission to do that.",
    );
  });
  it("retains ordinary error messages", () => {
    expect(describeMaintenanceError(new Error("offline"))).toBe("offline");
  });
});
