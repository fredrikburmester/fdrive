"use client";

import { useEffect, useState } from "react";
import { TEXT_LIMIT_BYTES } from "@/lib/preview/kind";
import { loadText } from "@/lib/preview/text-loader";

export type LoadedTextState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly text: string; readonly truncated: boolean };

/**
 * Loads `url` as text (capped at `TEXT_LIMIT_BYTES`) on mount and whenever
 * `url` changes, for the text, markdown, and code viewers. Not exported
 * from `lib/preview` because it is a React hook, not pure logic; the byte
 * cap and decoding it wraps (`loadText`) live there and are unit tested.
 */
export function useLoadedText(url: string): LoadedTextState {
  const [state, setState] = useState<LoadedTextState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    loadText(url, globalThis.fetch, { limit: TEXT_LIMIT_BYTES })
      .then((result) => {
        if (!cancelled) {
          setState({ status: "ready", text: result.text, truncated: result.truncated });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
