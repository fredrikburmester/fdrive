import type { FsEntry } from "@fdrive/contracts";
import { apiClient } from "@/lib/preview/deps";
import { previewKindFor } from "@/lib/preview/kind";
import { playsNatively, subtitlesFor } from "@/lib/preview/video";
import { ArchivePreview } from "./archive-preview";
import { AudioViewer } from "./audio-viewer";
import { CodeViewer } from "./code-viewer";
import { ImageViewer } from "./image-viewer";
import { MarkdownViewer } from "./markdown-viewer";
import { OfficePreview } from "./office-preview";
import { PdfViewer } from "./pdf-viewer";
import { TextViewer } from "./text-viewer";
import { Unsupported } from "./unsupported";
import { VideoViewer } from "./video-viewer";

export interface PreviewViewerProps {
  readonly entry: FsEntry;
  /** Inline (non-attachment) URL, used by every viewer that renders content. */
  readonly inlineUrl: string;
  /** Attachment URL, used only by the unsupported fallback's download button. */
  readonly downloadUrl: string;
  /** Optional high-res thumbnail URL for image preview fallback. */
  readonly thumbUrl?: string | undefined;
  /** The entry's folder, where the video viewer finds subtitle files named after the video. */
  readonly folderEntries?: readonly FsEntry[] | undefined;
  /**
   * The file is from an encrypted folder and `inlineUrl` is its decrypted bytes in memory: no
   * transcoding, subtitles, Office or archive listing, which the server cannot do for it.
   */
  readonly encrypted?: boolean | undefined;
}

/** Picks the right viewer for `entry`'s preview kind. */
export function PreviewViewer({
  entry,
  inlineUrl,
  downloadUrl,
  thumbUrl,
  folderEntries = [],
  encrypted = false,
}: PreviewViewerProps) {
  const kind = previewKindFor(entry);
  if (encrypted && (kind === "office" || kind === "none" || kind === "archive")) {
    return (
      <Unsupported
        name={entry.name}
        size={entry.size}
        kind={kind}
        reason="Download this file to open it."
        downloadUrl={downloadUrl}
      />
    );
  }
  if (encrypted && kind === "video") {
    return <VideoViewer src={inlineUrl} subtitles={[]} />;
  }

  switch (kind) {
    case "image":
      return (
        <ImageViewer
          src={inlineUrl}
          thumbUrl={thumbUrl}
          downloadUrl={downloadUrl}
          size={entry.size}
          name={entry.name}
        />
      );
    case "video":
      return (
        <VideoViewer
          src={playsNatively(entry.ext) ? inlineUrl : apiClient.transcodeUrl(entry.path)}
          subtitles={subtitlesFor(entry, folderEntries).map(({ path, label }) => ({
            src: apiClient.subtitlesUrl(path),
            label,
          }))}
        />
      );
    case "audio":
      return <AudioViewer src={inlineUrl} />;
    case "pdf":
      return <PdfViewer src={inlineUrl} title={entry.name} />;
    case "markdown":
      return <MarkdownViewer url={inlineUrl} />;
    case "code":
      return <CodeViewer url={inlineUrl} ext={entry.ext} />;
    case "text":
      return <TextViewer url={inlineUrl} />;
    case "office":
    case "none":
      return <OfficePreview entry={entry} downloadUrl={downloadUrl} />;
    case "archive":
      return <ArchivePreview entry={entry} downloadUrl={downloadUrl} />;
  }
}
