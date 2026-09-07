/** Cleanup is registered as resources are acquired and runs in reverse order. */
export function createCleanup() {
  const actions: Array<() => Promise<void>> = [];
  return {
    add(action: () => Promise<void>) {
      actions.push(action);
    },
    async close() {
      const errors: unknown[] = [];
      for (const action of actions.splice(0).reverse()) {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Performance fixture cleanup failed");
    },
  };
}

/** Cleanup failure invalidates the gate without preventing the observations artifact. */
export async function finishCleanup(
  stop: () => Promise<void>,
  failures: Record<string, string>,
): Promise<void> {
  try {
    await stop();
  } catch (error) {
    failures.cleanup = error instanceof Error ? error.message : "Fixture cleanup failed";
  }
}
