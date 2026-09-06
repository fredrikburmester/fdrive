import { extensionOf } from "@fdrive/core";
import { previewKindFor } from "./kind";

/**
 * The shape of loading skeleton to show while a preview's `stat` call is in
 * flight, before the real `PreviewKind` (which also depends on mime type and
 * size) is known. Grouped coarsely so the placeholder never reads as the
 * wrong kind of content (in particular, a `.ts` source file must not render
 * as a video frame while it loads).
 */
export type SkeletonKind = "lines" | "media" | "page" | "audio" | "card";

/**
 * Determines which loading skeleton to show for `path`, from its extension
 * alone (the only thing known before the file's `stat` response, which
 * carries the mime type and size, has loaded). Reuses `previewKindFor`'s
 * extension-first rules, so extensions that collide with a media mime type
 * (`.ts` with `video/mp2t`, for example) resolve the same way here as they
 * eventually will once the real preview kind is known.
 */
export function skeletonKindFor(path: string): SkeletonKind {
  const kind = previewKindFor({ ext: extensionOf(path), mime: null, size: 0 });
  switch (kind) {
    case "text":
    case "code":
    case "markdown":
      return "lines";
    case "image":
    case "video":
      return "media";
    case "pdf":
      return "page";
    case "audio":
      return "audio";
    case "office":
    case "archive":
    case "none":
      return "card";
  }
}
