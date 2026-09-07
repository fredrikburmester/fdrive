/** Explicit lifetime prevents retained scoped repositories using a released connection. */
export function createOfficeScopeLifetime(): { assertActive: () => void; close: () => void } {
  let active = true;
  return {
    assertActive() {
      if (!active) throw new Error("Office write scope has ended");
    },
    close() {
      active = false;
    },
  };
}
