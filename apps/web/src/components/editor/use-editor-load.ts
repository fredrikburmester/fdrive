"use client";

import type { FsEntry } from "@fdrive/contracts";
import { useEffect, useState } from "react";
import { apiClient, TEXT_LIMIT_BYTES } from "@/lib/editor/deps";
import { loadText } from "@/lib/preview/text-loader";

export type EditorLoadState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "too-large"; readonly entry: FsEntry }
  | {
      readonly status: "ready";
      readonly entry: FsEntry;
      readonly text: string;
      readonly truncated: boolean;
    };

/**
 * Loads `path`'s entry and, when it is small enough to edit, its text
 * content, as one unit keyed by `generation`. Bumping `generation` (the
 * "Reload file" action) re-runs both requests together, so the editor
 * never ends up with a stat and a document body from two different
 * moments in time. Not exported from `lib/editor` because it is a React
 * hook, not pure logic.
 */
export function useEditorLoad(path: string, generation: number): EditorLoadState {
  const [state, setState] = useState<EditorLoadState>({ status: "loading" });

  // `generation` has no direct use inside the effect: bumping it is the
  // whole point of the dependency, forcing this effect (and therefore the
  // stat + text fetch) to run again from scratch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    async function run() {
      try {
        const entry = await apiClient.stat(path);
        if (entry.size > TEXT_LIMIT_BYTES) {
          if (!cancelled) {
            setState({ status: "too-large", entry });
          }
          return;
        }

        const inlineUrl = apiClient.downloadUrl(path, { inline: true });
        const result = await loadText(inlineUrl, globalThis.fetch, { limit: TEXT_LIMIT_BYTES });
        if (!cancelled) {
          setState({ status: "ready", entry, text: result.text, truncated: result.truncated });
        }
      } catch {
        if (!cancelled) {
          setState({ status: "error" });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [path, generation]);

  return state;
}
