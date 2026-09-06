import type { SeedUser } from "@fdrive/testkit";

/** The perf-only SFTPGo user, full permissions, seeded alongside the shared testkit users. */
export const PERF_USER: SeedUser = {
  username: "perf",
  password: "perf-password",
  permissions: { "/": ["*"] },
};

export interface FlatSeedFile {
  readonly path: string;
  readonly sizeBytes: number;
}

/**
 * How many decimal digits are needed to zero pad every index in
 * `[0, count)` to the same width (the width of the largest index).
 */
export function paddingWidth(count: number): number {
  if (count <= 1) {
    return 1;
  }
  return String(count - 1).length;
}

/**
 * Builds the file paths and target sizes for a flat directory of `count`
 * same-size files under `dirPath`, e.g. `/flat-1k/0000.bin` .. `/flat-1k/0999.bin`
 * for `count = 1000`. Pure: same inputs always produce the same plan, and
 * every name is the same length (zero padded) so directory listings sort
 * numerically.
 */
export function buildFlatSeedPlan(
  dirPath: string,
  count: number,
  sizeBytes: number,
): FlatSeedFile[] {
  const width = paddingWidth(count);
  const plan: FlatSeedFile[] = [];
  for (let i = 0; i < count; i++) {
    const name = String(i).padStart(width, "0");
    plan.push({ path: `${dirPath}/${name}.bin`, sizeBytes });
  }
  return plan;
}
