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
import { isRawExt } from "@/lib/preview/raw";
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

/** A grid tile: the image's thumbnail, never counted, or an icon when it has none. A tile never
 * fetches the original: that is a download, and would spend a limited link once per tile. */
function GalleryTile({
  image,
  thumbUrl,
  onOpen,
}: {
  image: GalleryImage;
  thumbUrl: (path: string, size: ThumbSize) => string;
  onOpen: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);

  return (
    <button
      type="button"
      aria-label={image.name}
      className="group relative aspect-square overflow-hidden rounded-lg border bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={onOpen}
    >
      {thumbFailed ? (
        <span className="flex h-full w-full items-center justify-center">
          <ImageIcon className="size-8 text-muted-foreground" />
        </span>
      ) : (
        /* biome-ignore lint/performance/noImgElement: the public share page has no Next.js image loader for arbitrary API-served URLs */
        <img
          src={thumbUrl(image.path, 256)}
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

/** A full-size image the lightbox opened as a counted preview: its URL, or why it failed. */
type OpenedImage = { readonly url: string } | { readonly error: string };

/**
 * The lightbox's image: the 1024px thumbnail (cached, preloaded) the moment it is shown, then the
 * full-size image once its preview is open and the image has decoded, so stepping never shows an
 * empty frame. Keyed by path, so another image starts from its own thumbnail. A share whose
 * files are not indexed has no thumbnail: its `onError` falls straight through to the full
 * image. HEIC hands the original to `ImageViewer`, which decodes it itself; a camera raw file is
 * only ever its thumbnail.
 */
function LightboxImage({
  image,
  thumbUrl,
  downloadUrl,
  opened,
}: {
  image: GalleryImage;
  thumbUrl: (path: string, size: ThumbSize) => string;
  downloadUrl: (path: string) => string;
  opened: OpenedImage | undefined;
}) {
  const [fullLoaded, setFullLoaded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const heic = isHeicExt(extensionOf(image.name));
  const full = opened !== undefined && "url" in opened ? opened.url : null;
  useEffect(() => {
    if (heic || full === null) return;
    const preload = new Image();
    preload.src = full;
    if (preload.complete) setFullLoaded(true);
    else preload.onload = () => setFullLoaded(true);
    return () => {
      preload.onload = null;
    };
  }, [full, heic]);
  const thumb = thumbUrl(image.path, 1024);
  const src = full !== null && (heic || fullLoaded || thumbFailed) ? full : thumb;
  return (
    <div className="relative h-full">
      <ImageViewer
        src={src}
        thumbUrl={thumb}
        downloadUrl={downloadUrl(image.path)}
        name={image.name}
        onError={() => setThumbFailed(true)}
      />
      {opened !== undefined && "error" in opened && (
        <p
          role="status"
          className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
        >
          {opened.error}
        </p>
      )}
    </div>
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
  opened,
  onClose,
  onStep,
}: {
  image: GalleryImage;
  index: number;
  total: number;
  thumbUrl: (path: string, size: ThumbSize) => string;
  downloadUrl: (path: string) => string;
  opened: OpenedImage | undefined;
  onClose: () => void;
  onStep: (delta: 1 | -1) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
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
        <LightboxImage
          key={image.path}
          image={image}
          thumbUrl={thumbUrl}
          downloadUrl={downloadUrl}
          opened={opened}
        />
      </div>
    </div>
  );
}

/**
 * Bounded image grid for the public share page. Tiles show a thumbnail (`thumbUrl`, never
 * counted as a download) with `loading="lazy"`; a tap opens the full-page lightbox, which opens
 * the full-size image as a preview (`previewUrl`), counted once per image however often the
 * visitor steps back to it, with previous/next, a per-image download, and Escape or the close
 * button to return to the grid. The neighbours' 1024px thumbnails are preloaded whenever the
 * open index changes, so stepping through the lightbox rarely shows a blank frame.
 */
export function PublicGallery({
  images,
  thumbUrl,
  downloadUrl,
  previewUrl,
}: {
  images: readonly GalleryImage[];
  thumbUrl: (path: string, size: ThumbSize) => string;
  downloadUrl: (path: string) => string;
  /** Opens one image as a counted preview, resolving to the URL its full-size reads use. */
  previewUrl: (path: string) => Promise<string>;
}) {
  const [shown, setShown] = useState(() => galleryVisibleCount(images.length, 0));
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [opened, setOpened] = useState<ReadonlyMap<string, OpenedImage>>(() => new Map());
  const requested = useRef(new Set<string>());
  useEffect(() => {
    setShown(galleryVisibleCount(images.length, 0));
    setOpenIndex(null);
  }, [images]);
  const visible = images.slice(0, shown);
  const active = openIndex === null ? null : (visible[openIndex] ?? null);
  /** Shows image `index` in the lightbox, opening its full size once. Called from clicks and
   * keys, never an effect, so React's development double effects never open it twice. */
  function show(index: number) {
    setOpenIndex(index);
    const image = visible[index];
    // A camera raw file is only ever shown as its thumbnail, so there is nothing to open.
    if (image === undefined || isRawExt(extensionOf(image.name))) return;
    if (requested.current.has(image.path)) return;
    requested.current.add(image.path);
    const settle = (result: OpenedImage) =>
      setOpened((current) => new Map(current).set(image.path, result));
    previewUrl(image.path).then(
      (url) => settle({ url }),
      (cause: unknown) =>
        settle({
          error: cause instanceof Error ? cause.message : "The full-size image is unavailable.",
        }),
    );
  }
  // Preloads the neighbours' *thumbnails*, not their full-size images: each full-size image is
  // a counted preview, opened only when the visitor steps to it. The 1024px thumbnail is
  // cacheable, so it is on screen the instant the arrow is pressed while the full image loads.
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
            onOpen={() => show(index)}
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
          opened={opened.get(active.path)}
          onClose={() => setOpenIndex(null)}
          onStep={(delta) => show(stepLightboxIndex(openIndex, visible.length, delta))}
        />
      )}
    </div>
  );
}
