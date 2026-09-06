import { describe, expect, it } from "vitest";
import {
  formatJobBytesRead,
  formatJobFileProgress,
  formatJobProgress,
  jobDisplayName,
  jobOpenFolderPath,
  jobProgressFraction,
  jobStateLabel,
  jobTitle,
} from "./format";
import type { JobRequest } from "./types";

describe("jobStateLabel", () => {
  it("labels every state", () => {
    expect(jobStateLabel("queued")).toBe("Queued");
    expect(jobStateLabel("running")).toBe("Running");
    expect(jobStateLabel("done")).toBe("Done");
    expect(jobStateLabel("failed")).toBe("Failed");
    expect(jobStateLabel("cancelled")).toBe("Cancelled");
  });
});

describe("jobTitle", () => {
  it("uses the present participle while queued or running", () => {
    expect(jobTitle("compress", "queued")).toBe("Compressing");
    expect(jobTitle("compress", "running")).toBe("Compressing");
    expect(jobTitle("extract", "queued")).toBe("Extracting");
    expect(jobTitle("extract", "running")).toBe("Extracting");
  });

  it("uses the past participle once done", () => {
    expect(jobTitle("compress", "done")).toBe("Compressed");
    expect(jobTitle("extract", "done")).toBe("Extracted");
  });

  it("names the noun for failed and cancelled", () => {
    expect(jobTitle("compress", "failed")).toBe("Compress failed");
    expect(jobTitle("compress", "cancelled")).toBe("Compress cancelled");
    expect(jobTitle("extract", "failed")).toBe("Extract failed");
    expect(jobTitle("extract", "cancelled")).toBe("Extract cancelled");
  });
});

describe("formatJobFileProgress", () => {
  it("shows the total when known", () => {
    expect(formatJobFileProgress({ processed: 12, total: 40, bytes: 0 })).toBe("12 of 40 files");
  });

  it("uses singular 'file' for a total of exactly one", () => {
    expect(formatJobFileProgress({ processed: 1, total: 1, bytes: 0 })).toBe("1 of 1 file");
  });

  it("omits the total when unknown", () => {
    expect(formatJobFileProgress({ processed: 12, total: null, bytes: 0 })).toBe("12 files");
  });

  it("uses singular 'file' for a processed count of exactly one, total unknown", () => {
    expect(formatJobFileProgress({ processed: 1, total: null, bytes: 0 })).toBe("1 file");
  });
});

describe("formatJobBytesRead", () => {
  it("formats the byte count with a 'read' suffix", () => {
    expect(formatJobBytesRead({ processed: 0, total: null, bytes: 1536 })).toBe("1.5 KB read");
  });
});

describe("formatJobProgress", () => {
  it("combines the file and byte progress", () => {
    expect(formatJobProgress({ processed: 12, total: 40, bytes: 1536 })).toBe(
      "12 of 40 files · 1.5 KB read",
    );
  });
});

describe("jobProgressFraction", () => {
  it("returns null when the total is unknown", () => {
    expect(jobProgressFraction({ processed: 5, total: null, bytes: 0 })).toBeNull();
  });

  it("returns null when the total is zero", () => {
    expect(jobProgressFraction({ processed: 0, total: 0, bytes: 0 })).toBeNull();
  });

  it("returns the processed fraction of the total", () => {
    expect(jobProgressFraction({ processed: 5, total: 20, bytes: 0 })).toBe(0.25);
  });

  it("clamps at 1 even if processed exceeds total", () => {
    expect(jobProgressFraction({ processed: 25, total: 20, bytes: 0 })).toBe(1);
  });
});

describe("jobDisplayName", () => {
  const compressRequest: JobRequest = {
    kind: "compress",
    req: { paths: ["/docs"], format: "zip", name: "docs" },
  };
  const compressRequestNoName: JobRequest = {
    kind: "compress",
    req: { paths: ["/docs"], format: "zip" },
  };
  const extractRequest: JobRequest = {
    kind: "extract",
    req: { path: "/docs.zip" },
  };

  it("uses the result path's base name once known", () => {
    expect(jobDisplayName("/docs.zip", compressRequest)).toBe("docs.zip");
  });

  it("prefers the result path even when a request is also known", () => {
    expect(jobDisplayName("/renamed.zip", compressRequest)).toBe("renamed.zip");
  });

  it("falls back to the compress request's name", () => {
    expect(jobDisplayName(undefined, compressRequest)).toBe("docs");
  });

  it("falls back to 'archive' for a compress request without a name", () => {
    expect(jobDisplayName(undefined, compressRequestNoName)).toBe("archive");
  });

  it("falls back to the extract request's archive base name", () => {
    expect(jobDisplayName(undefined, extractRequest)).toBe("docs.zip");
  });

  it("falls back to a generic label when neither is known", () => {
    expect(jobDisplayName(undefined, undefined)).toBe("Job");
  });
});

describe("jobOpenFolderPath", () => {
  it("returns null before the job has a result", () => {
    expect(jobOpenFolderPath("compress", undefined)).toBeNull();
  });

  it("returns the archive's parent folder for a compress job", () => {
    expect(jobOpenFolderPath("compress", "/a/docs.zip")).toBe("/a");
  });

  it("returns the destination folder itself for an extract job", () => {
    expect(jobOpenFolderPath("extract", "/a/docs")).toBe("/a/docs");
  });
});
