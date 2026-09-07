import { expect, it } from "vitest";
import {
  publicShareUsage,
  shareAccessLabel,
  shareItemLabel,
  shareUnavailable,
  shareUsage,
} from "./status";

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
  expect(shareAccessLabel("read")).toBe("Can view");
  expect(shareAccessLabel("write")).toBe("Can upload");
  expect(shareItemLabel(["/photos/summer.jpg"])).toBe("summer.jpg");
  expect(shareItemLabel(["/"])).toBe("Everything");
  expect(shareItemLabel([])).toBe("Everything");
  expect(shareItemLabel(["/a.txt", "/b.txt"])).toBe("2 items");
  expect(publicShareUsage({ scope: "read", maxDownloads: 0, usedDownloads: 5 })).toBeNull();
  expect(publicShareUsage({ scope: "read", maxDownloads: 3, usedDownloads: 1 })).toBe(
    "1 of 3 downloads",
  );
  expect(publicShareUsage({ scope: "write", maxDownloads: 2, usedDownloads: 2 })).toBe(
    "2 of 2 uploads",
  );
});
