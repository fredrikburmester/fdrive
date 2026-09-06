"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Builds an object URL for `text`, debounced by `delayMs` so the markdown
 * preview pane (which reloads whenever its `url` prop changes) does not
 * refetch on every keystroke. Revokes the previous object URL whenever a
 * new one is created or the component unmounts.
 */
export function usePreviewObjectUrl(text: string, delayMs: number): string {
  const [url, setUrl] = useState(() => URL.createObjectURL(new Blob([text])));
  const urlRef = useRef(url);
  urlRef.current = url;

  useEffect(() => {
    const timeout = setTimeout(() => {
      setUrl((previous) => {
        URL.revokeObjectURL(previous);
        return URL.createObjectURL(new Blob([text]));
      });
    }, delayMs);
    return () => clearTimeout(timeout);
  }, [text, delayMs]);

  useEffect(() => {
    return () => URL.revokeObjectURL(urlRef.current);
  }, []);

  return url;
}
