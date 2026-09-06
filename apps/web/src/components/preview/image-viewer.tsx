"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface ImageViewerProps {
  readonly src: string;
  readonly alt: string;
}

/**
 * A repeating two-tone checkerboard, built from the `--muted` and
 * `--background` theme tokens, shown behind transparent images so alpha
 * channels are visible without hardcoding a colour.
 */
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, var(--muted) 25%, transparent 25%), " +
    "linear-gradient(-45deg, var(--muted) 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, var(--muted) 75%), " +
    "linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
};

/**
 * Fits an image to the available space by default; clicking toggles to its
 * natural (100%) size inside a scrollable viewport. A subtle checkerboard
 * shows through transparent pixels.
 */
export function ImageViewer({ src, alt }: ImageViewerProps) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-auto"
      style={CHECKERBOARD_STYLE}
    >
      <Button
        variant="ghost"
        onClick={() => setZoomed((prev) => !prev)}
        aria-pressed={zoomed}
        aria-label={zoomed ? "Zoom out" : "Zoom in"}
        className={zoomed ? "contents cursor-zoom-out" : "contents cursor-zoom-in"}
      >
        {/* biome-ignore lint/performance/noImgElement: previews load arbitrary API-served bytes, not a static asset next/image can optimize */}
        <img
          src={src}
          alt={alt}
          className={zoomed ? "max-w-none" : "max-h-full max-w-full object-contain"}
        />
      </Button>
    </div>
  );
}
