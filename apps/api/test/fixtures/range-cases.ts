import { expect } from "vitest";

/**
 * What every route that serves a file's bytes (`/fs/download`, a share
 * link's download, Office's GetFile) answers for `RANGE_FILE` under each
 * `Range` and `If-Range`: they share one implementation, and each route's
 * tests check it against this one table.
 */

/** The file every case reads: ten bytes. */
export const RANGE_FILE = "0123456789";

export interface RangeCase {
  readonly range?: string;
  readonly ifRange?: string;
  readonly status: 200 | 206 | 416;
  readonly contentRange: string | null;
  /** The bytes sent; empty for a 416. */
  readonly body: string;
}

/** The cases for a `RANGE_FILE` last modified at `modifiedAt`. */
export function rangeCases(modifiedAt: Date): readonly RangeCase[] {
  const whole = { status: 200, contentRange: null, body: RANGE_FILE } as const;
  const unsatisfiable = { status: 416, contentRange: "bytes */10", body: "" } as const;
  const current = modifiedAt.toUTCString();
  const earlier = new Date(modifiedAt.getTime() - 60_000).toUTCString();
  return [
    { ...whole },
    { range: "bytes=0-4", status: 206, contentRange: "bytes 0-4/10", body: "01234" },
    { range: "bytes=6-", status: 206, contentRange: "bytes 6-9/10", body: "6789" },
    // Suffix ranges count back from the end, and one longer than the file is all of it.
    { range: "bytes=-4", status: 206, contentRange: "bytes 6-9/10", body: "6789" },
    { range: "bytes=-20", status: 206, contentRange: "bytes 0-9/10", body: RANGE_FILE },
    // An end past the file is its last byte; a start at or past it is unsatisfiable.
    { range: "bytes=2-99", status: 206, contentRange: "bytes 2-9/10", body: "23456789" },
    {
      range: "bytes=0-9007199254740993",
      status: 206,
      contentRange: "bytes 0-9/10",
      body: RANGE_FILE,
    },
    { range: "bytes=10-", ...unsatisfiable },
    { range: "bytes=20-30", ...unsatisfiable },
    { range: "bytes=4-2", ...unsatisfiable },
    { range: "bytes=-0", ...unsatisfiable },
    { range: "nonsense", ...unsatisfiable },
    // Several ranges get the whole file; a malformed set of them is unsatisfiable.
    { range: "bytes=0-1,6-7", ...whole },
    { range: "bytes=4-2,6-7", ...unsatisfiable },
    // If-Range applies the range only while it names the file's current second.
    {
      range: "bytes=0-4",
      ifRange: current,
      status: 206,
      contentRange: "bytes 0-4/10",
      body: "01234",
    },
    { range: "bytes=0-4", ifRange: earlier, ...whole },
    { range: "bytes=0-4", ifRange: '"an-etag"', ...whole },
    { range: "bytes=0-4", ifRange: 'W/"an-etag"', ...whole },
    { range: "bytes=20-", ifRange: earlier, ...whole },
  ];
}

/** The request headers for `item`. */
export function rangeHeaders(item: RangeCase): Record<string, string> {
  return {
    ...(item.range === undefined ? {} : { range: item.range }),
    ...(item.ifRange === undefined ? {} : { "if-range": item.ifRange }),
  };
}

/** A label naming `item` in a failed expectation. */
export function rangeLabel(item: RangeCase): string {
  return `${item.range ?? "no range"} / ${item.ifRange ?? "no If-Range"}`;
}

/** Checks `response` answered `item` as every file route must. */
export async function expectRangeAnswer(response: Response, item: RangeCase): Promise<void> {
  const label = rangeLabel(item);
  expect(response.status, label).toBe(item.status);
  expect(response.headers.get("content-range"), label).toBe(item.contentRange);
  if (item.status !== 416) {
    expect(response.headers.get("content-length"), label).toBe(String(item.body.length));
    expect(response.headers.get("accept-ranges"), label).toBe("bytes");
  }
  expect(await response.text(), label).toBe(item.body);
}
