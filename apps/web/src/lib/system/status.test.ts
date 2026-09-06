import { describe, expect, it } from "vitest";
import { sidecarStatus, sidecarStatusLabel } from "./status";

describe("sidecarStatus", () => {
  it("returns not_configured when configured is false, regardless of reachable", () => {
    expect(sidecarStatus(false, false)).toBe("not_configured");
    expect(sidecarStatus(false, true)).toBe("not_configured");
  });

  it("returns unreachable when configured but not reachable", () => {
    expect(sidecarStatus(true, false)).toBe("unreachable");
  });

  it("returns ok when configured and reachable", () => {
    expect(sidecarStatus(true, true)).toBe("ok");
  });
});

describe("sidecarStatusLabel", () => {
  it("labels every status", () => {
    expect(sidecarStatusLabel("ok")).toBe("Reachable");
    expect(sidecarStatusLabel("unreachable")).toBe("Unreachable");
    expect(sidecarStatusLabel("not_configured")).toBe("Not configured");
  });
});
