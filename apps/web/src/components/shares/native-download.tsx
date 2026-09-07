"use client";

import { Download } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { downloadFrameError } from "@/lib/shares/download";

/** Successful attachments stream natively; only the API's JSON errors enter React. */
export function NativeShareDownload({
  href,
  label = "Download",
  onError,
}: {
  href: string;
  label?: string;
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
  return (
    <div className="space-y-2">
      <Button
        nativeButton={false}
        role="link"
        render={<a href={href} target={name} />}
        onClick={() => {
          setError(null);
          expected.current = new URL(href, window.location.origin).href;
        }}
      >
        <Download />
        {label}
      </Button>
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
