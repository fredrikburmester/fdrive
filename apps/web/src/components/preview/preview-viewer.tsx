import type { FsEntry } from "@fdrive/contracts";
import { previewKindFor } from "@/lib/preview/kind";
import { ArchivePreview } from "./archive-preview";
import { AudioViewer } from "./audio-viewer";
import { CodeViewer } from "./code-viewer";
import { ImageViewer } from "./image-viewer";
import { MarkdownViewer } from "./markdown-viewer";
import { OfficePreview } from "./office-preview";
import { PdfViewer } from "./pdf-viewer";
import { TextViewer } from "./text-viewer";
import { VideoViewer } from "./video-viewer";

export interface PreviewViewerProps {
  readonly entry: FsEntry;
  /** Inline (non-attachment) URL, used by every viewer that renders content. */
  readonly inlineUrl: string;
  /** Attachment URL, used only by the unsupported fallback's download button. */
  readonly downloadUrl: string;
}

/** Picks the right viewer for `entry`'s preview kind. */
export function PreviewViewer({ entry, inlineUrl, downloadUrl }: PreviewViewerProps) {
  const kind = previewKindFor(entry);

  switch (kind) {
    case "image":
      return <ImageViewer src={inlineUrl} alt={entry.name} />;
    case "video":
      return <VideoViewer src={inlineUrl} />;
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
