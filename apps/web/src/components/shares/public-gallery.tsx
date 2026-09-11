"use client";

import type { ThumbSize } from "@fdrive/contracts";
import { extensionOf } from "@fdrive/core";
import { ChevronLeft, ChevronRight, Image as ImageIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ImageViewer } from "@/components/preview/image-viewer";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isHeicExt } from "@/lib/preview/heic";
import {
  galleryVisibleCount,
  hasMoreGalleryItems,
  neighborIndexes,
  stepLightboxIndex,
} from "@/lib/shares/gallery";
import { NativeShareDownload } from "./native-download";

export interface GalleryImage {
  readonly name: string;
  readonly path: string;
}

/** One icon button in the lightbox top bar, wrapped in a tooltip, matching the ghost icon
 * buttons `TopBarAction` renders in `components/preview/preview-shell.tsx`. */
function LightboxAction({
  label,
  disabled = false,
  className,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            className={className}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A grid tile: a thumbnail by default, falling back per-tile to the full download URL when
 * the thumbnail 404s (the file is not indexed, or the deployment has no index profile). */
function GalleryTile({
  image,
  thumbUrl,
  downloadUrl,
  onOpen,
}: {
  image: GalleryImage;
  thumbUrl: (path: string, size: ThumbSize) => string;
  downloadUrl: (path: string) => string;
  onOpen: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const isHeic = isHeicExt(extensionOf(image.name));

  return (
    <button
      type="button"
      aria-label={image.name}
      className="group relative aspect-square overflow-hidden rounded-lg border bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={onOpen}
    >
      {thumbFailed && isHeic ? (
        <span className="flex h-full w-full items-center justify-center">
          <ImageIcon className="size-8 text-muted-foreground" />
        </span>
      ) : (
        /* biome-ignore lint/performance/noImgElement: the public share page has no Next.js image loader for arbitrary API-served URLs */
        <img
          src={thumbFailed ? downloadUrl(image.path) : thumbUrl(image.path, 256)}
          alt={image.name}
          loading="lazy"
          decoding="async"
          onError={() => setThumbFailed(true)}
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
      )}
    </button>
  );
}

/**
 * The full-page lightbox: a `fixed inset-0` overlay reading as the logged-in
 * `components/preview/preview-shell.tsx` view (same `h-12` top bar shape, ghost icon buttons
 * with tooltips, the shared `ImageViewer` for the image body) rather than a Base UI `Dialog`,
 * per the user's explicit request for a full page, not a modal. Body scroll is locked and focus
 * moves into the overlay while it is open, and is restored to the tile that opened it on close.
 */
function Lightbox({
  image,
  index,
  total,
  thumbUrl,
  downloadUrl,
  onClose,
  onStep,
}: {
  image: GalleryImage;
  index: number;
  total: number;
  thumbUrl: (path: string, size: ThumbSize) => string;
  downloadUrl: (path: string) => string;
  onClose: () => void;
  onStep: (delta: 1 | -1) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  // Shows the (cached, preloaded) 1024px thumbnail the moment an arrow is
  // pressed, and swaps to the full-size image once it has decoded, so
  // stepping never shows an empty frame. Keyed by path so moving to another
  // image starts from its thumbnail again rather than holding the previous
  // full image. A share whose files are not indexed has no thumbnail: the
  // `onError` there falls straight through to the full image.
  const [fullLoaded, setFullLoaded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const isHeic = isHeicExt(extensionOf(image.name));
  useEffect(() => {
    if (isHeic) return;
    setFullLoaded(false);
    setThumbFailed(false);
    const full = new Image();
    full.src = downloadUrl(image.path);
    if (full.complete) setFullLoaded(true);
    else full.onload = () => setFullLoaded(true);
    return () => {
      full.onload = null;
    };
  }, [image.path, downloadUrl, isHeic]);
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") onStep(1);
      else if (event.key === "ArrowLeft") onStep(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);
  const activeSrc = isHeic
    ? downloadUrl(image.path)
    : fullLoaded || thumbFailed
      ? downloadUrl(image.path)
      : thumbUrl(image.path, 1024);
  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-background outline-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm supports-backdrop-filter:bg-background/60">
        <LightboxAction label="Close" onClick={onClose}>
          <X />
          <span className="sr-only">Close</span>
        </LightboxAction>
        <Separator orientation="vertical" className="h-5" />
        <span className="min-w-0 truncate text-sm font-medium">{image.name}</span>
        <div className="flex flex-1 items-center justify-center gap-1">
          {total > 1 && (
            <>
              <LightboxAction label="Previous" onClick={() => onStep(-1)}>
                <ChevronLeft />
                <span className="sr-only">Previous</span>
              </LightboxAction>
              <span className="text-xs text-muted-foreground tabular-nums">
                {index + 1} / {total}
              </span>
              <LightboxAction label="Next" onClick={() => onStep(1)}>
                <ChevronRight />
                <span className="sr-only">Next</span>
              </LightboxAction>
            </>
          )}
        </div>
        <NativeShareDownload href={downloadUrl(image.path)} icon />
      </header>
      <div className="min-h-0 flex-1">
        <ImageViewer
          key={image.path}
          src={activeSrc}
          thumbUrl={thumbUrl(image.path, 1024)}
          downloadUrl={downloadUrl(image.path)}
          name={image.name}
          onError={() => setThumbFailed(true)}
        />
      </div>
    </div>
  );
}

/**
 * Bounded image grid for the public share page. Tiles show a thumbnail (`thumbUrl`, never
 * counted as a download) with `loading="lazy"`; a tap opens the full-page lightbox on the
 * full-size image (`downloadUrl`), with previous/next, a per-image download, and Escape or the
 * close button to return to the grid. The neighbouring full-size images are preloaded whenever
 * the open index changes, so stepping through the lightbox rarely shows a blank frame.
 */
export function PublicGallery({
  images,
  thumbUrl,
  downloadUrl,
}: {
  images: readonly GalleryImage[];
  thumbUrl: (path: string, size: ThumbSize) => string;
  downloadUrl: (path: string) => string;
}) {
  const [shown, setShown] = useState(() => galleryVisibleCount(images.length, 0));
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  useEffect(() => {
    setShown(galleryVisibleCount(images.length, 0));
    setOpenIndex(null);
  }, [images]);
  const visible = images.slice(0, shown);
  const active = openIndex === null ? null : (visible[openIndex] ?? null);
  // Preloads the neighbours' *thumbnails*, not their full-size images: a
  // full download answers `no-store`, so a preloaded one could never be
  // reused and would only spend another of the link's downloads. The 1024px
  // thumbnail is cacheable, so it is on screen the instant the arrow is
  // pressed while the full image loads behind it.
  useEffect(() => {
    if (openIndex === null) return;
    for (const neighbor of neighborIndexes(openIndex, visible.length)) {
      const neighborImage = visible[neighbor];
      if (neighborImage) new Image().src = thumbUrl(neighborImage.path, 1024);
    }
  }, [openIndex, visible, thumbUrl]);
  if (images.length === 0)
    return (
      <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        This shared folder has no images.
      </p>
    );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {visible.map((image, index) => (
          <GalleryTile
            key={image.path}
            image={image}
            thumbUrl={thumbUrl}
            downloadUrl={downloadUrl}
            onOpen={() => setOpenIndex(index)}
          />
        ))}
      </div>
      {hasMoreGalleryItems(images.length, shown) && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => setShown((current) => galleryVisibleCount(images.length, current))}
          >
            Show more
          </Button>
        </div>
      )}
      {active && openIndex !== null && (
        <Lightbox
          image={active}
          index={openIndex}
          total={visible.length}
          thumbUrl={thumbUrl}
          downloadUrl={downloadUrl}
          onClose={() => setOpenIndex(null)}
          onStep={(delta) =>
            setOpenIndex((current) =>
              current === null ? current : stepLightboxIndex(current, visible.length, delta),
            )
          }
        />
      )}
    </div>
  );
}
