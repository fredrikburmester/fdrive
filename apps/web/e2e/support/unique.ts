/**
 * A name unlikely to collide with any other test's, even across parallel
 * workers hitting the same seeded folder: `${prefix}-<time>-<random>`.
 */
export function uniqueName(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${random}`;
}
