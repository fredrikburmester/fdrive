"use client";

import { Badge } from "@/components/ui/badge";
import { languageFor } from "@/lib/preview/kind";
import { LineNumberedText } from "./line-numbered-text";
import { useLoadedText } from "./use-loaded-text";

export interface CodeViewerProps {
  readonly url: string;
  readonly ext: string;
}

/**
 * Source code preview: monospace, line numbers, a language badge, a notice
 * when truncated. No syntax highlighting in this chunk.
 */
export function CodeViewer({ url, ext }: CodeViewerProps) {
  const state = useLoadedText(url);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <Badge variant="secondary">{languageFor(ext)}</Badge>
        {state.status === "ready" && state.truncated && (
          <span className="text-xs text-muted-foreground">Showing the first 2 MiB</span>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {state.status === "loading" && (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        )}
        {state.status === "error" && (
          <div className="p-6 text-sm text-destructive">Could not load this file.</div>
        )}
        {state.status === "ready" && <LineNumberedText text={state.text} />}
      </div>
    </div>
  );
}
