"use client";

import { Download } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { downloadFrameError } from "@/lib/shares/download";

/**
 * Successful attachments stream natively; only the API's JSON errors enter React. `icon`
 * renders the same ghost icon button with a tooltip that `TopBarAction` in
 * `preview-shell.tsx` uses, for the directory header's ZIP control and the lightbox's per-image
 * download; the default labelled button stays for the standalone `ZipDownloadCard` and other
 * plain download actions.
 */
export function NativeShareDownload({
  href,
  label = "Download",
  icon = false,
  onError,
}: {
  href: string;
  label?: string;
  icon?: boolean;
  onError?: (message: string) => void;
}) {
  const name = useId();
  const frame = useRef<HTMLIFrameElement>(null);
  const expected = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function loaded() {
    if (!expected.current) return;
    try {
      const doc = frame.current?.contentDocument;
      const url = frame.current?.contentWindow?.location.href;
      if (!doc || !url || url !== expected.current) return;
      const message = downloadFrameError({
        href: url,
        expected: expected.current,
        contentType: doc.contentType,
        text: (doc.body?.textContent ?? "").slice(0, 8193),
      });
      if (message) {
        setError(message);
        onError?.(message);
      }
    } catch {
      setError("Could not download this file. Try opening the link again.");
    }
  }
  function armed() {
    setError(null);
    expected.current = new URL(href, window.location.origin).href;
  }
  return (
    <div className="space-y-2">
      {icon ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                nativeButton={false}
                role="link"
                render={<a href={href} target={name} />}
                onClick={armed}
              />
            }
          >
            <Download />
            <span className="sr-only">{label}</span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        <Button
          nativeButton={false}
          role="link"
          render={<a href={href} target={name} />}
          onClick={armed}
        >
          <Download />
          {label}
        </Button>
      )}
      <iframe
        ref={frame}
        name={name}
        title="Download response"
        hidden
        sandbox="allow-same-origin allow-downloads"
        onLoad={loaded}
      />
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
