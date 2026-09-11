import { describe, expect, it } from "vitest";
import { PATH_CHUNK_SIZE, selectPathChunks } from "./path-chunks.js";

/**
 * Stands in for one `path in (...)` statement: it records the chunk it was
 * handed and answers from a fixed table of rows, so a test can compare the
 * chunked result against what a single unchunked statement would return.
 */
function recordingSelect(rows: readonly { path: string; tagId: string }[]) {
  const chunks: string[][] = [];
  const select = (chunk: string[]) => {
    chunks.push(chunk);
    const wanted = new Set(chunk);
    return Promise.resolve(rows.filter((row) => wanted.has(row.path)));
  };
  return { chunks, select };
}

const pathAt = (index: number) => `/dir/file-${index}.txt`;

function listingOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => pathAt(index));
}

describe("PATH_CHUNK_SIZE", () => {
  it("leaves clear headroom under the 65535 bound-parameter limit", () => {
    expect(PATH_CHUNK_SIZE).toBe(4095);
    // One `identity_id` parameter rides along with every chunk.
    expect(PATH_CHUNK_SIZE + 1).toBeLessThan(65_535);
  });
});

describe("selectPathChunks", () => {
  it("runs no query for an empty path list", async () => {
    const { chunks, select } = recordingSelect([]);

    await expect(selectPathChunks([], select)).resolves.toEqual([]);

    expect(chunks).toEqual([]);
  });

  it("runs exactly one query with the paths unchanged when they fit one chunk", async () => {
    const listing = listingOf(3);
    const rows = [{ path: pathAt(1), tagId: "work" }];
    const { chunks, select } = recordingSelect(rows);

    await expect(selectPathChunks(listing, select)).resolves.toEqual(rows);

    expect(chunks).toEqual([listing]);
  });

  it("still runs one query at exactly the chunk size", async () => {
    const listing = listingOf(PATH_CHUNK_SIZE);
    const { chunks, select } = recordingSelect([]);

    await selectPathChunks(listing, select);

    expect(chunks).toHaveLength(1);
    expect(chunks.flat()).toEqual(listing);
  });

  it("splits one path past the chunk size into two bounded queries", async () => {
    const listing = listingOf(PATH_CHUNK_SIZE + 1);
    const { chunks, select } = recordingSelect([]);

    await selectPathChunks(listing, select);

    expect(chunks.map((chunk) => chunk.length)).toEqual([PATH_CHUNK_SIZE, 1]);
    expect(chunks.flat()).toEqual(listing);
  });

  it("keeps every chunk within the parameter budget for a listing past the hard limit", async () => {
    const listing = listingOf(70_000);
    const { chunks, select } = recordingSelect([]);

    await selectPathChunks(listing, select);

    expect(chunks).toHaveLength(Math.ceil(70_000 / PATH_CHUNK_SIZE));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(PATH_CHUNK_SIZE);
    }
    expect(chunks.flat()).toEqual(listing);
  });

  it("merges a multi-chunk listing into exactly the rows an unchunked query returns", async () => {
    const size = PATH_CHUNK_SIZE * 2 + 17;
    const listing = listingOf(size);
    const rows = [
      { path: pathAt(0), tagId: "work" },
      { path: pathAt(0), tagId: "personal" },
      { path: pathAt(PATH_CHUNK_SIZE - 1), tagId: "work" },
      { path: pathAt(PATH_CHUNK_SIZE), tagId: "personal" },
      { path: pathAt(PATH_CHUNK_SIZE * 2), tagId: "work" },
      { path: pathAt(size - 1), tagId: "work" },
    ];
    const chunked = recordingSelect(rows);
    const single = recordingSelect(rows);

    const merged = await selectPathChunks(listing, chunked.select);

    expect(chunked.chunks.length).toBeGreaterThan(1);
    expect(merged).toEqual(await single.select([...listing]));
  });

  it("omits rows for paths that are absent from the listing", async () => {
    const listing = listingOf(PATH_CHUNK_SIZE + 5);
    const kept = { path: pathAt(7), tagId: "work" };
    const { select } = recordingSelect([kept, { path: "/elsewhere.txt", tagId: "work" }]);

    await expect(selectPathChunks(listing, select)).resolves.toEqual([kept]);
  });

  it("counts a duplicated path once instead of returning its rows per chunk", async () => {
    const duplicated = "/dir/twice.txt";
    const listing = [duplicated, ...listingOf(PATH_CHUNK_SIZE), duplicated];
    const rows = [{ path: duplicated, tagId: "work" }];
    const { chunks, select } = recordingSelect(rows);

    await expect(selectPathChunks(listing, select)).resolves.toEqual(rows);

    expect(chunks).toHaveLength(2);
    expect(chunks.flat().filter((path) => path === duplicated)).toEqual([duplicated]);
  });

  it("queries chunks one at a time rather than all at once", async () => {
    let inFlight = 0;
    let concurrent = 0;
    const select = async (chunk: string[]) => {
      inFlight += 1;
      concurrent = Math.max(concurrent, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return chunk.map((path) => ({ path }));
    };

    const rows = await selectPathChunks(listingOf(PATH_CHUNK_SIZE * 3), select);

    expect(concurrent).toBe(1);
    expect(rows).toHaveLength(PATH_CHUNK_SIZE * 3);
  });
});
