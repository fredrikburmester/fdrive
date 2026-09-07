import { expect, it } from "vitest";
import { shareUnavailable, shareUsage } from "./status";

it("reports explicit and locally elapsed share limits", () => {
  const valid = { expiresAt: null, maxDownloads: 0, usedDownloads: 0, unavailableReason: null };
  expect(shareUnavailable(valid)).toBeNull();
  expect(shareUnavailable({ ...valid, expiresAt: "2030-01-01T00:00:00Z" }, 0)).toBeNull();
  expect(shareUnavailable({ ...valid, expiresAt: "2020-01-01T00:00:00Z" })).toContain("expired");
  expect(shareUnavailable({ ...valid, unavailableReason: "expired" })).toContain("expired");
  expect(shareUnavailable({ ...valid, unavailableReason: "limit" })).toContain("limit");
  expect(shareUnavailable({ ...valid, maxDownloads: 2, usedDownloads: 2 })).toContain("limit");
  expect(shareUnavailable({ ...valid, maxDownloads: 2, usedDownloads: 1 })).toBeNull();
  expect(shareUsage({ scope: "read", maxDownloads: 3, usedDownloads: 1 })).toBe("1 of 3 downloads");
  expect(shareUsage({ scope: "write", maxDownloads: 0, usedDownloads: 2 })).toBe(
    "2 uploads · No limit",
  );
});
