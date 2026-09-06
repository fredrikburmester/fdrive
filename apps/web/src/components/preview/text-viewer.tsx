"use client";

import { LineNumberedText } from "./line-numbered-text";
import { TruncatedNotice } from "./truncated-notice";
import { useLoadedText } from "./use-loaded-text";

export interface TextViewerProps {
  readonly url: string;
}

/** Plain text preview: monospace, line numbers, a notice when truncated. */
export function TextViewer({ url }: TextViewerProps) {
  const state = useLoadedText(url);

  if (state.status === "loading") {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (state.status === "error") {
    return <div className="p-6 text-sm text-destructive">Could not load this file.</div>;
  }

  return (
    <div className="h-full overflow-auto">
      {state.truncated && <TruncatedNotice />}
      <LineNumberedText text={state.text} />
    </div>
  );
}
