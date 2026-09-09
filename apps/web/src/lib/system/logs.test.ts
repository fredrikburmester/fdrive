import type { SystemLogEntry } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { formatLogLines, formatLogTime, LOG_LEVEL_FILTERS, logFileName, toNdjson } from "./logs";

const ENTRIES: SystemLogEntry[] = [
  {
    id: "api:2",
    at: "2026-09-09T10:20:30.000Z",
    level: "warn",
    message: "Index clear requested",
    data: { root: "sftpgo" },
    source: "api",
  },
  {
    id: "scan:1",
    at: "2026-09-09T10:00:00.000Z",
    level: "info",
    message: "Scan of sftpgo finished: 16 seen, 0 changed, 0 deleted",
    source: "indexer",
  },
];

describe("formatLogLines", () => {
  it("emits the ISO time, a padded level, the message and one-line data", () => {
    expect(formatLogLines(ENTRIES)).toEqual([
      '2026-09-09T10:20:30.000Z  WARN   Index clear requested  {"root":"sftpgo"}',
      "2026-09-09T10:00:00.000Z  INFO   Scan of sftpgo finished: 16 seen, 0 changed, 0 deleted",
    ]);
  });

  it("returns no lines for no entries", () => {
    expect(formatLogLines([])).toEqual([]);
  });
});

describe("toNdjson", () => {
  it("writes one JSON object per line", () => {
    const lines = toNdjson(ENTRIES).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual(ENTRIES[0]);
  });
});

describe("logFileName", () => {
  it("names the file after the subsystem, the day and the format", () => {
    expect(logFileName("image-search", "ndjson", new Date("2026-09-09T23:59:00Z"))).toBe(
      "fdrive-image-search-logs-2026-09-09.ndjson",
    );
  });
});

describe("formatLogTime", () => {
  it("renders a 24-hour clock with seconds", () => {
    expect(formatLogTime("2026-09-09T10:20:30.000Z")).toMatch(/^\d{2}:\d{2}:30$/);
  });

  it("falls back to the raw value when it is not a date", () => {
    expect(formatLogTime("not a date")).toBe("not a date");
  });
});

describe("LOG_LEVEL_FILTERS", () => {
  it("offers the three minimum levels in severity order", () => {
    expect(LOG_LEVEL_FILTERS.map((filter) => filter.value)).toEqual(["info", "warn", "error"]);
  });
});
