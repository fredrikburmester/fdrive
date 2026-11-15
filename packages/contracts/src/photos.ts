import { z } from "zod";

/** The camera's wall-clock time from a photo's EXIF, without a time zone: `2024-05-01T14:03:09`. */
const TakenAt = z.iso.datetime({ local: true }).nullable();

/** One image in `GET /api/v1/photos`. `takenAt` is null for an image without EXIF. */
export const PhotoItem = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().min(0),
  modifiedAt: z.iso.datetime(),
  takenAt: TakenAt,
});

export type PhotoItem = z.infer<typeof PhotoItem>;

/**
 * One page of every image the caller can read, newest first by when it was taken, or by
 * its modification time without EXIF. `nextCursor` asks for the next page; null at the end.
 */
export const PhotosResponse = z.object({
  photos: z.array(PhotoItem),
  nextCursor: z.string().nullable(),
});

export type PhotosResponse = z.infer<typeof PhotosResponse>;

/** A photo's details from its EXIF, each null when the photo does not have it. */
export const PhotoDetailsResponse = z.object({
  takenAt: TakenAt,
  camera: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

export type PhotoDetailsResponse = z.infer<typeof PhotoDetailsResponse>;
