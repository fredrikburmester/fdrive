import { z } from "zod";

/** The thumbnail sizes the API generates and serves, in pixels (longest edge). */
export const THUMB_SIZES = [256, 1024] as const;

/** One of the supported thumbnail sizes, as a number (see `THUMB_SIZES`). */
export type ThumbSize = (typeof THUMB_SIZES)[number];

/** Query parameters for `GET /api/v1/thumb`. `size` arrives as a raw string. */
export const ThumbQuery = z.object({
  path: z.string(),
  size: z.enum(["256", "1024"]),
});

export type ThumbQuery = z.infer<typeof ThumbQuery>;
