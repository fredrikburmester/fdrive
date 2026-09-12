/** Bounds the independent cache-backed stats used by virtual listings. */
export function createStatQueue(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      signal.throwIfAborted();
      const result = await work();
      signal.throwIfAborted();
      return result;
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
