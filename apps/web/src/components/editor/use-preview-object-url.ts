"use client";

import { useEffect, useRef, useState } from "react";

interface PreviewObjectUrl {
  /** The text this object URL was minted from. */
  readonly text: string;
  readonly url: string;
}

function mint(text: string): PreviewObjectUrl {
  return { text, url: URL.createObjectURL(new Blob([text])) };
}

/**
 * Builds an object URL for `text`, debounced by `delayMs` so the markdown
 * preview pane (which reloads whenever its `url` prop changes) does not
 * refetch on every keystroke.
 *
 * Exactly one object URL is alive at a time and the effect below owns its
 * lifetime: it revokes on cleanup and mints a replacement on setup, so React
 * Strict Mode's setup -> cleanup -> setup remount (which `next dev` performs
 * on every mount) hands back a live URL instead of the revoked one. Creation
 * is deliberately kept out of the `useState` initialiser and out of set-state
 * updaters, because Strict Mode double-invokes both and every discarded call
 * would leak a blob for the lifetime of the page.
 *
 * The first URL is minted during render rather than in the effect: the
 * preview pane fetches its `url` prop from its own effect, which React runs
 * before this component's effects, so an empty first value would make it
 * request the current page. The `live` ref keeps that to one creation per
 * mount even though Strict Mode renders the component twice.
 */
export function usePreviewObjectUrl(text: string, delayMs: number): string {
  const [debouncedText, setDebouncedText] = useState(text);
  const [, setRevision] = useState(0);
  const live = useRef<PreviewObjectUrl | null>(null);
  if (live.current === null) {
    live.current = mint(debouncedText);
  }
  const rendered = live.current;

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedText(text), delayMs);
    return () => clearTimeout(timeout);
  }, [text, delayMs]);

  useEffect(() => {
    let owned = live.current;
    if (owned === null || owned.text !== debouncedText) {
      if (owned !== null) {
        // The render that minted this URL saw an older debounced text: the
        // timeout above can fire between a commit and its passive effects.
        URL.revokeObjectURL(owned.url);
      }
      owned = mint(debouncedText);
      live.current = owned;
      setRevision((revision) => revision + 1);
    }
    const released = owned;
    return () => {
      URL.revokeObjectURL(released.url);
      if (live.current === released) {
        live.current = null;
      }
    };
  }, [debouncedText]);

  return rendered.url;
}
