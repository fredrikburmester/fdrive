import { type Db, schema } from "@fdrive/db";
import { count } from "drizzle-orm";

/** Reads how many thumbnails have been generated, for the System > Thumbnails page. */
export interface ThumbnailsRepo {
  /** The number of rows in `app.thumbnails` (one per generated size of a distinct file). */
  count(): Promise<number>;
}

/** Builds a `ThumbnailsRepo` backed by `db`. Thin by design; see `src/system/thumbnails-repo.test.ts`. */
export function createThumbnailsRepo(db: Db): ThumbnailsRepo {
  return {
    async count() {
      const [row] = await db.select({ value: count() }).from(schema.thumbnails);
      return row?.value ?? 0;
    },
  };
}
