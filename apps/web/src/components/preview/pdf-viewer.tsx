export interface PdfViewerProps {
  readonly src: string;
  readonly title: string;
}

/** Renders a PDF inline via an `<iframe>` that fills the available height. */
export function PdfViewer({ src, title }: PdfViewerProps) {
  return <iframe src={src} title={title} className="h-full w-full border-0" />;
}
