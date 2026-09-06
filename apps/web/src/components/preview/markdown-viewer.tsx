"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TruncatedNotice } from "./truncated-notice";
import { useLoadedText } from "./use-loaded-text";

export interface MarkdownViewerProps {
  readonly url: string;
}

/**
 * Renders GitHub-flavoured markdown with `react-markdown`; raw HTML in the
 * source is never rendered (no `rehype-raw` plugin is used). Prose styling
 * comes from theme tokens via arbitrary-variant selectors, not a plugin.
 */
export function MarkdownViewer({ url }: MarkdownViewerProps) {
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
      <div
        className={[
          "mx-auto max-w-3xl p-8 text-sm leading-7 text-foreground",
          "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:first:mt-0",
          "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold",
          "[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-medium",
          "[&_p]:my-3",
          "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6",
          "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
          "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
          "[&_hr]:my-6 [&_hr]:border-border",
          "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
          "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
          "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4",
          "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
          "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse",
          "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
          "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
        ].join(" ")}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.text}</ReactMarkdown>
      </div>
    </div>
  );
}
