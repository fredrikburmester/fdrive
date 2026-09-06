import { describe, expect, it } from "vitest";
import { estimateSpeed, formatEta, formatSpeed, type ThroughputSample } from "./format.ts";

describe("estimateSpeed", () => {
  it("returns 0 with fewer than two samples", () => {
    expect(estimateSpeed([])).toBe(0);
    expect(estimateSpeed([{ timestampMs: 0, bytesDone: 0 }])).toBe(0);
  });

  it("computes bytes per second across the whole window", () => {
    const samples: ThroughputSample[] = [
      { timestampMs: 0, bytesDone: 0 },
      { timestampMs: 1000, bytesDone: 1000 },
    ];
    expect(estimateSpeed(samples)).toBe(1000);
  });

  it("only considers samples within the window", () => {
    const samples: ThroughputSample[] = [
      { timestampMs: 0, bytesDone: 0 },
      { timestampMs: 10000, bytesDone: 100 },
      { timestampMs: 12000, bytesDone: 4100 },
    ];
    // window defaults to 5000ms, so only the last two samples count: 2s, 4000 bytes.
    expect(estimateSpeed(samples)).toBe(2000);
  });

  it("returns 0 when the window collapses to a single sample", () => {
    const samples: ThroughputSample[] = [
      { timestampMs: 0, bytesDone: 0 },
      { timestampMs: 100, bytesDone: 50 },
    ];
    expect(estimateSpeed(samples, 0)).toBe(0);
  });

  it("returns 0 when elapsed time is zero", () => {
    const samples: ThroughputSample[] = [
      { timestampMs: 100, bytesDone: 0 },
      { timestampMs: 100, bytesDone: 50 },
    ];
    expect(estimateSpeed(samples)).toBe(0);
  });

  it("returns 0 when bytes did not increase", () => {
    const samples: ThroughputSample[] = [
      { timestampMs: 0, bytesDone: 100 },
      { timestampMs: 1000, bytesDone: 100 },
    ];
    expect(estimateSpeed(samples)).toBe(0);
  });
});

describe("formatSpeed", () => {
  it("appends /s to a byte-formatted rate", () => {
    expect(formatSpeed(1536)).toBe("1.5 KB/s");
  });
});

describe("formatEta", () => {
  it("returns '0s' once nothing remains", () => {
    expect(formatEta(0, 1000)).toBe("0s");
    expect(formatEta(-5, 1000)).toBe("0s");
  });

  it("returns 'calculating...' when speed is unknown", () => {
    expect(formatEta(1000, 0)).toBe("calculating...");
    expect(formatEta(1000, -1)).toBe("calculating...");
  });

  it("formats seconds under a minute", () => {
    expect(formatEta(45, 1)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatEta(192, 1)).toBe("3m 12s");
  });

  it("formats whole minutes without seconds", () => {
    expect(formatEta(180, 1)).toBe("3m");
  });

  it("formats hours and minutes", () => {
    expect(formatEta(7500, 1)).toBe("2h 5m");
  });

  it("formats whole hours without minutes", () => {
    expect(formatEta(7200, 1)).toBe("2h");
  });
});
