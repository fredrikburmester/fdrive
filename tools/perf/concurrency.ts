/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight at
 * once, preserving the input order in the returned array regardless of
 * completion order. Used by the perf harness to seed thousands of files
 * without opening thousands of simultaneous connections.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) {
        // Unreachable given index < items.length, kept to satisfy
        // noUncheckedIndexedAccess without a non-null assertion.
        continue;
      }
      results[index] = await fn(item, index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
