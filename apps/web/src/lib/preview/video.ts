import type { FsEntry } from "@fdrive/contracts";

/** Video every browser plays itself; the API transcodes any other video as it plays. */
const NATIVE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([".mp4", ".m4v", ".mov", ".webm"]);

export function playsNatively(ext: string): boolean {
  return NATIVE_VIDEO_EXTENSIONS.has(ext.toLowerCase());
}

/** A subtitle file the video viewer offers, labelled by what its name adds (`en` in `Movie.en.srt`). */
export interface SubtitleFile {
  readonly path: string;
  readonly label: string;
}

type Entry = Pick<FsEntry, "name" | "path" | "ext" | "kind">;

/** The `.srt` and `.vtt` files in `entries` named after `video`: `Movie.srt`, `Movie.en.srt`. */
export function subtitlesFor(video: Pick<FsEntry, "name" | "ext">, entries: readonly Entry[]) {
  const prefix = `${video.name.slice(0, video.name.length - video.ext.length)}.`;
  return entries
    .filter(
      (entry) =>
        entry.kind === "file" &&
        (entry.ext === ".srt" || entry.ext === ".vtt") &&
        entry.name.startsWith(prefix),
    )
    .map(
      (entry): SubtitleFile => ({
        path: entry.path,
        label: entry.name.slice(prefix.length, entry.name.length - entry.ext.length) || "Subtitles",
      }),
    );
}
