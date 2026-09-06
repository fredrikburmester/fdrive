import { customType } from "drizzle-orm/pg-core";

export interface VectorConfig {
  readonly dimensions: number;
}

/**
 * Formats a number array as the pgvector text literal, e.g. `[0.1,0.2,0.3]`.
 * Exported so it can be unit tested without a database connection.
 */
export function formatVectorLiteral(value: readonly number[]): string {
  return `[${value.join(",")}]`;
}

/**
 * Parses a pgvector text literal (with or without surrounding brackets) back
 * into a number array. Exported so it can be unit tested without a database
 * connection.
 */
export function parseVectorLiteral(value: string): number[] {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  if (inner.length === 0) {
    return [];
  }

  return inner.split(",").map((part) => Number.parseFloat(part));
}

/**
 * pgvector column type: `vector(dimensions)` in Postgres, a plain
 * `number[]` in application code. The wire format is the pgvector text
 * literal in both directions.
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config: VectorConfig;
  configRequired: true;
}>({
  dataType(config) {
    return `vector(${config.dimensions})`;
  },
  toDriver(value) {
    return formatVectorLiteral(value);
  },
  fromDriver(value) {
    return parseVectorLiteral(value);
  },
});
