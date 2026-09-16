"use client";

import { extensionOf } from "@fdrive/core";
import { ImageOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchHeicAsJpeg, isHeicExt } from "@/lib/preview/heic";
import { isRawExt, RAW_NO_THUMBNAIL } from "@/lib/preview/raw";
import { Unsupported } from "./unsupported";

export interface ImageViewerProps {
  readonly src: string;
  /** The file name: rendered as the image's alt text and used to detect HEIC/HEIF and camera raw. */
  readonly name: string;
  /** A 1024px thumbnail: shown for HEIC in browsers that cannot decode it natively, and the only thing shown for camera raw. */
  readonly thumbUrl?: string | undefined;
  /** Attachment URL for the download button when a HEIC or raw cannot be shown at all. */
  readonly downloadUrl?: string | undefined;
  /** The file's size, when known: a HEIC over the decode cap is refused before download. */
  readonly size?: number | undefined;
  /** Called when a plain (non-HEIC, non-raw) image fails to load. */
  readonly onError?: (() => void) | undefined;
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
 * natural (100%) size inside a scrollable viewport.
 *
 * For HEIC/HEIF images:
 * - `<picture><source type="image/heic">` lets Safari decode the file natively.
 * - Elsewhere the 1024px `thumbUrl` shows first; zooming, or a missing
 *   thumbnail, decodes the full file to JPEG in the browser.
 * - A failed decode keeps whatever is already on screen and reports the
 *   reason in a pill; only when nothing can be shown does the unsupported
 *   card with a download button take over.
 *
 * For camera raw images (ARW, CR3, NEF, DNG, ...), which no browser decodes,
 * the 1024px `thumbUrl` is the whole preview: the file itself is never
 * fetched, zooming shows the thumbnail at its natural size, and a missing or
 * failed thumbnail shows the unsupported card with a download button.
 *
 * Callers key the viewer by file: state is per file, not reset on `src` changes.
 */
export function ImageViewer({ src, name, thumbUrl, downloadUrl, size, onError }: ImageViewerProps) {
  const ext = extensionOf(name);
  const isHeic = isHeicExt(ext);
  const isRaw = isRawExt(ext);
  const [zoomed, setZoomed] = useState(false);
  const [decoded, setDecoded] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [nativeSupported, setNativeSupported] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const objectUrlRef = useRef<string | null>(null);
  const decodePromiseRef = useRef<Promise<string | undefined> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      decodePromiseRef.current = null;
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  const startDecode = (): Promise<string | undefined> => {
    if (decodePromiseRef.current !== null) return decodePromiseRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setDecoding(true);
    setDecodeError(null);
    const promise = (async () => {
      try {
        const jpeg = await fetchHeicAsJpeg(src, { size, signal: controller.signal });
        if (controller.signal.aborted) return undefined;
        const url = URL.createObjectURL(jpeg);
        objectUrlRef.current = url;
        setDecoded(url);
        return url;
      } catch (err) {
        if (controller.signal.aborted) return undefined;
        setDecodeError(err instanceof Error ? err.message : "Decoding failed");
        return undefined;
      } finally {
        if (!controller.signal.aborted) {
          setDecoding(false);
          decodePromiseRef.current = null;
        }
      }
    })();
    decodePromiseRef.current = promise;
    return promise;
  };

  const handleZoomClick = async () => {
    if (zoomed) {
      setZoomed(false);
      return;
    }
    if (isHeic && !nativeSupported && decoded === null) {
      if (await startDecode()) setZoomed(true);
      return;
    }
    setZoomed(true);
  };

  const handleImgError = () => {
    if (isRaw) {
      setImgFailed(true);
      return;
    }
    if (!isHeic) {
      onError?.();
      return;
    }
    setImgFailed(true);
    if (decoded === null) void startDecode();
  };

  if (isRaw && (thumbUrl === undefined || imgFailed)) {
    return (
      <Unsupported
        name={name}
        size={size}
        kind="image"
        reason={RAW_NO_THUMBNAIL}
        downloadUrl={downloadUrl ?? src}
      />
    );
  }

  const displaySrc = isRaw ? thumbUrl : isHeic ? (decoded ?? thumbUrl ?? src) : src;

  if (isHeic && imgFailed && decoded === null && decodeError !== null) {
    return (
      <Unsupported
        name={name}
        size={size}
        kind="image"
        reason={decodeError}
        downloadUrl={downloadUrl ?? src}
      />
    );
  }

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-auto"
      style={CHECKERBOARD_STYLE}
    >
      <Button
        variant="ghost"
        onClick={handleZoomClick}
        aria-pressed={zoomed}
        aria-label={zoomed ? "Zoom out" : "Zoom in"}
        className={zoomed ? "contents cursor-zoom-out" : "contents cursor-zoom-in"}
      >
        <picture className="contents">
          {isHeic && <source type="image/heic" srcSet={src} />}
          <img
            src={displaySrc}
            onLoad={(e) => {
              setImgFailed(false);
              if (isHeic && e.currentTarget.currentSrc.includes(src)) setNativeSupported(true);
            }}
            onError={handleImgError}
            alt={name}
            className={zoomed ? "max-w-none" : "max-h-full max-w-full object-contain"}
          />
        </picture>
      </Button>
      {(decoding || decodeError !== null) && (
        <div
          role="status"
          className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
        >
          {decoding ? (
            <>
              <Loader2 className="size-3 animate-spin text-primary" />
              Decoding full resolution…
            </>
          ) : (
            <>
              <ImageOff className="size-3 text-destructive" />
              {decodeError}
            </>
          )}
        </div>
      )}
    </div>
  );
}
