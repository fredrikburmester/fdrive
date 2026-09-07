"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { galleryVisibleCount, hasMoreGalleryItems, stepLightboxIndex } from "@/lib/shares/gallery";
import { NativeShareDownload } from "./native-download";

export interface GalleryImage {
  readonly name: string;
  readonly path: string;
}

/**
 * Bounded image grid for the public share page. Tiles use the public download route as `img
 * src` with `loading="lazy"` so a large folder never decodes every image at once; a tap opens a
 * full-size lightbox with previous/next, a per-image Download button, and Escape or the close
 * button to return to the grid.
 */
export function PublicGallery({
  images,
  downloadUrl,
}: {
  images: readonly GalleryImage[];
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
  useEffect(() => {
    if (openIndex === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowRight")
        setOpenIndex((current) =>
          current === null ? current : stepLightboxIndex(current, visible.length, 1),
        );
      else if (event.key === "ArrowLeft")
        setOpenIndex((current) =>
          current === null ? current : stepLightboxIndex(current, visible.length, -1),
        );
    }
    // Capture phase: Base UI's Dialog popup calls `stopPropagation` on composite navigation
    // keys, including the arrow keys, during the bubble phase. A bubble-phase window listener
    // would never see them; a capture-phase one runs first, before that call happens.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openIndex, visible.length]);
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
          <button
            key={image.path}
            type="button"
            className="group relative aspect-square overflow-hidden rounded-lg border bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => setOpenIndex(index)}
          >
            {/* biome-ignore lint/performance/noImgElement: the public share page has no Next.js image loader for arbitrary download-proxied URLs */}
            <img
              src={downloadUrl(image.path)}
              alt={image.name}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          </button>
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
      <Dialog
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null);
        }}
      >
        <DialogContent
          showCloseButton
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col gap-3 sm:max-w-4xl"
        >
          {active && (
            <>
              <DialogTitle className="truncate pr-8">
                {visible.length > 1 ? `${(openIndex ?? 0) + 1} of ${visible.length} · ` : ""}
                {active.name}
              </DialogTitle>
              <div className="relative flex min-h-0 flex-1 items-center justify-center">
                {visible.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous image"
                    className="absolute left-0"
                    onClick={() =>
                      setOpenIndex((current) =>
                        current === null ? current : stepLightboxIndex(current, visible.length, -1),
                      )
                    }
                  >
                    <ChevronLeft />
                  </Button>
                )}
                {/* biome-ignore lint/performance/noImgElement: same download-proxied URL as the grid tiles */}
                <img
                  src={downloadUrl(active.path)}
                  alt={active.name}
                  decoding="async"
                  className="max-h-[70vh] max-w-full rounded-lg object-contain"
                />
                {visible.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next image"
                    className="absolute right-0"
                    onClick={() =>
                      setOpenIndex((current) =>
                        current === null ? current : stepLightboxIndex(current, visible.length, 1),
                      )
                    }
                  >
                    <ChevronRight />
                  </Button>
                )}
              </div>
              <div className="flex justify-end">
                <NativeShareDownload href={downloadUrl(active.path)} />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
