"use client";

import { extensionOf } from "@fdrive/core";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AudioViewer } from "@/components/preview/audio-viewer";
import { ImageViewer } from "@/components/preview/image-viewer";
import { LineNumberedText } from "@/components/preview/line-numbered-text";
import { PdfViewer } from "@/components/preview/pdf-viewer";
import { VideoViewer } from "@/components/preview/video-viewer";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { isHeicExt } from "@/lib/preview/heic";
import { fetchPublicPreview, type PublicPreviewKind } from "@/lib/shares/preview";

type PreviewState =
  | { type: "loading" }
  | { type: "text"; text: string }
  | { type: "blob"; url: string }
  | { type: "error"; message: string };

export function PublicPreview({
  url,
  name,
  kind,
  thumbUrl,
  size,
  onClose,
}: {
  url: string;
  name: string;
  kind: Exclude<PublicPreviewKind, "none">;
  thumbUrl?: string | undefined;
  size?: number | undefined;
  onClose: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ type: "loading" });
  useEffect(() => {
    if (kind === "image" || kind === "audio" || kind === "video") return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({ type: "loading" });
    void fetchPublicPreview(url, kind, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (typeof result === "string") setState({ type: "text", text: result });
        else {
          objectUrl = URL.createObjectURL(result);
          setState({ type: "blob", url: objectUrl });
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setState({
            type: "error",
            message: cause instanceof Error ? cause.message : "Could not preview this file.",
          });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, kind]);
  const failed = () =>
    setState({
      type: "error",
      message: "Could not preview this file. Check the password or download the file instead.",
    });
  return (
    <section
      aria-label={`Preview of ${name}`}
      className="overflow-hidden rounded-xl border bg-background"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close preview
        </Button>
      </div>
      {state.type === "error" ? (
        <div className="p-5">
          <FieldError>{state.message}</FieldError>
        </div>
      ) : (
        <div className="h-[min(65vh,44rem)]">
          {kind === "image" ? (
            <ImageViewer
              src={url}
              alt={name}
              thumbUrl={thumbUrl}
              downloadUrl={url}
              size={size}
              isHeic={isHeicExt(extensionOf(name))}
              onError={failed}
            />
          ) : kind === "audio" ? (
            <AudioViewer src={url} onError={failed} />
          ) : kind === "video" ? (
            <VideoViewer src={url} onError={failed} />
          ) : state.type === "blob" ? (
            <PdfViewer src={state.url} title={name} />
          ) : state.type === "text" ? (
            kind === "markdown" ? (
              <div className="h-full overflow-auto p-6 text-sm leading-7 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3">
                <ReactMarkdown
                  skipHtml
                  remarkPlugins={[remarkGfm]}
                  components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}
                >
                  {state.text}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="h-full overflow-auto">
                <LineNumberedText text={state.text} />
              </div>
            )
          ) : (
            <p role="status" className="p-5 text-sm text-muted-foreground">
              Loading preview…
            </p>
          )}
        </div>
      )}
    </section>
  );
}
