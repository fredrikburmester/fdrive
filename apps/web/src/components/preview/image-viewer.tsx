"use client";

import { Download, ImageOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { decodeHeicBlob } from "@/lib/preview/heic";

export interface ImageViewerProps {
  readonly src: string;
  readonly alt: string;
  readonly thumbUrl?: string | undefined;
  readonly downloadUrl?: string | undefined;
  readonly size?: number | undefined;
  readonly isHeic?: boolean | undefined;
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
 * - Uses `<picture><source type="image/heic">` for native Safari hardware decoding.
 * - In non-native browsers (Chromium/Firefox), initializes to `thumbUrl` (1024px WebP).
 * - On zoom or thumbnail 404, dynamically decodes the full file to JPEG via `heic-to/csp`.
 */
export function ImageViewer({
  src,
  alt,
  thumbUrl,
  downloadUrl,
  size: _size,
  isHeic = false,
  onError,
}: ImageViewerProps) {
  const [zoomed, setZoomed] = useState(false);
  const [displaySrc, setDisplaySrc] = useState<string>(() => (isHeic ? (thumbUrl ?? src) : src));
  const [nativeSupported, setNativeSupported] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [errorState, setErrorState] = useState<string | null>(null);

  const objectUrlRef = useRef<string | null>(null);
  const decodePromiseRef = useRef<Promise<string | undefined> | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    setDisplaySrc(isHeic ? (thumbUrl ?? src) : src);
    setZoomed(false);
    setNativeSupported(false);
    setDecoding(false);
    setErrorState(null);
    decodePromiseRef.current = null;
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, [src, isHeic, thumbUrl]);

  useEffect(() => {
    return () => {
      decodePromiseRef.current = null;
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  const startDecode = (): Promise<string | undefined> => {
    if (decodePromiseRef.current !== null) {
      return decodePromiseRef.current;
    }
    const currentGeneration = ++generationRef.current;
    setDecoding(true);
    const promise = (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`Failed to load file: HTTP ${res.status}`);
        const blob = await res.blob();
        if (generationRef.current !== currentGeneration) return undefined;

        const jpegBlob = await decodeHeicBlob(blob);
        if (generationRef.current !== currentGeneration) return undefined;

        if (objectUrlRef.current !== null) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        const url = URL.createObjectURL(jpegBlob);
        objectUrlRef.current = url;
        setDisplaySrc(url);
        return url;
      } catch (err) {
        if (generationRef.current !== currentGeneration) return undefined;
        const message = err instanceof Error ? err.message : "Decoding failed";
        setErrorState(message);
        onError?.();
        return undefined;
      } finally {
        if (generationRef.current === currentGeneration) {
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
    if (isHeic && !nativeSupported && displaySrc !== objectUrlRef.current) {
      const decodedUrl = await startDecode();
      if (decodedUrl) {
        setZoomed(true);
      }
    } else {
      setZoomed(true);
    }
  };

  const handleImgError = () => {
    if (!isHeic) {
      onError?.();
      return;
    }
    if (displaySrc !== objectUrlRef.current) {
      void startDecode();
      return;
    }
    setErrorState("Could not display image");
    onError?.();
  };

  if (isHeic && errorState !== null) {
    const fileDownload = downloadUrl ?? src;
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Card className="max-w-sm">
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            <ImageOff className="size-8 text-destructive" />
            <CardTitle className="text-base font-medium">Could not load image</CardTitle>
            <p className="text-xs text-muted-foreground">{errorState}</p>
            {fileDownload && (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={fileDownload} download />}
              >
                <Download className="mr-2 size-4" />
                Download file
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
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
              if (isHeic) {
                const img = e.currentTarget;
                if (img.currentSrc?.includes(src)) {
                  setNativeSupported(true);
                }
              }
            }}
            onError={handleImgError}
            alt={alt}
            className={zoomed ? "max-w-none" : "max-h-full max-w-full object-contain"}
          />
        </picture>
      </Button>
      {decoding && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
          <Loader2 className="size-3 animate-spin text-primary" />
          Decoding full resolution…
        </div>
      )}
    </div>
  );
}
