"use client";
import type { OfficeOpenResponse } from "@fdrive/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { OfficeMessage } from "@/lib/office/messages";
import { parseOfficeMessage } from "@/lib/office/messages";

export interface OfficeFrameProps {
  descriptor: OfficeOpenResponse;
  onMessage: (message: OfficeMessage) => void;
  onRetry: () => void;
}

/** Token fields exist only in this ephemeral POST form, never in a URL or query cache. */
export function OfficeFrame({ descriptor, onMessage, onRetry }: OfficeFrameProps) {
  const id = useId();
  const target = `office-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const submitted = useRef<OfficeOpenResponse | null>(null);
  const messageHandler = useRef(onMessage);
  messageHandler.current = onMessage;
  const [slow, setSlow] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setReady(false);
    setFailed(false);
    setSlow(false);
    const timeout = window.setTimeout(() => setSlow(true), 45_000);
    function receive(event: MessageEvent<unknown>) {
      const message = parseOfficeMessage(
        event,
        descriptor.editorOrigin,
        frame.current?.contentWindow,
      );
      if (message === null) return;
      if (message.MessageId === "App_LoadingStatus") {
        const status = message.Values?.Status;
        setFailed(status === "Failed");
        if (status === "Failed") setReady(false);
        if (status === undefined || status === "Document_Loaded") setReady(true);
        if (status === undefined || status === "Document_Loaded" || status === "Failed")
          window.clearTimeout(timeout);
      }
      messageHandler.current(message);
    }
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
    };
  }, [descriptor]);

  useEffect(() => {
    if (form.current !== null && submitted.current !== descriptor) {
      submitted.current = descriptor;
      HTMLFormElement.prototype.submit.call(form.current);
    }
  }, [descriptor]);

  function postReady() {
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ MessageId: "Host_PostmessageReady", SendTime: Date.now(), Values: {} }),
      descriptor.editorOrigin,
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {!ready && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 border-b border-border px-3 py-2 text-muted-foreground text-sm"
        >
          {failed
            ? "The editor could not open this document."
            : slow
              ? "The editor has not responded. Check its connection or reopen the document."
              : "Opening office…"}
          {(slow || failed) && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Reopen
            </Button>
          )}
        </div>
      )}
      <form ref={form} action={descriptor.actionUrl} method="post" target={target} hidden>
        {Object.entries(descriptor.formFields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} readOnly />
        ))}
      </form>
      <iframe
        ref={frame}
        name={target}
        title="Office document"
        className="min-h-0 w-full flex-1 border-0"
        onLoad={postReady}
        sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-downloads allow-modals"
        allow="clipboard-read; clipboard-write; fullscreen"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
