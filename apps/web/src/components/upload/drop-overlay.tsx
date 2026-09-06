"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { isExternalFileDrag } from "@/lib/dnd";
import { collectDroppedFiles, type DroppedFile } from "@/lib/upload/traverse";

export interface UseExternalDropOptions {
  readonly disabled?: boolean;
}

export interface UseExternalDropResult {
  readonly isDraggingOver: boolean;
}

/**
 * Wires `dragenter`/`dragover`/`dragleave`/`drop` on `ref.current` to detect
 * a drag of files from outside the browser. Uses an enter/leave counter so
 * the overlay does not flicker as the pointer crosses child elements, and
 * ignores fdrive's own internal drag-and-drop (moving entries within the
 * app, see `src/lib/dnd.ts`). Calls `onDrop` with every file discovered by
 * `collectDroppedFiles` once a drop completes.
 */
export function useExternalDrop(
  ref: RefObject<HTMLElement | null>,
  onDrop: (files: DroppedFile[]) => void,
  options: UseExternalDropOptions = {},
): UseExternalDropResult {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const depthRef = useRef(0);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const disabled = options.disabled === true;

  useEffect(() => {
    const node = ref.current;
    if (node === null || disabled) {
      return;
    }

    function isRelevant(event: DragEvent): boolean {
      return event.dataTransfer !== null && isExternalFileDrag(event.dataTransfer);
    }

    function handleDragEnter(event: DragEvent): void {
      if (!isRelevant(event)) {
        return;
      }
      event.preventDefault();
      depthRef.current += 1;
      setIsDraggingOver(true);
    }

    function handleDragOver(event: DragEvent): void {
      if (!isRelevant(event)) {
        return;
      }
      event.preventDefault();
    }

    function handleDragLeave(event: DragEvent): void {
      if (!isRelevant(event)) {
        return;
      }
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) {
        setIsDraggingOver(false);
      }
    }

    function handleDrop(event: DragEvent): void {
      if (!isRelevant(event) || event.dataTransfer === null) {
        return;
      }
      event.preventDefault();
      depthRef.current = 0;
      setIsDraggingOver(false);
      const dataTransfer = event.dataTransfer;
      void collectDroppedFiles(dataTransfer).then((files) => onDropRef.current(files));
    }

    node.addEventListener("dragenter", handleDragEnter);
    node.addEventListener("dragover", handleDragOver);
    node.addEventListener("dragleave", handleDragLeave);
    node.addEventListener("drop", handleDrop);

    return () => {
      node.removeEventListener("dragenter", handleDragEnter);
      node.removeEventListener("dragover", handleDragOver);
      node.removeEventListener("dragleave", handleDragLeave);
      node.removeEventListener("drop", handleDrop);
    };
  }, [ref, disabled]);

  return { isDraggingOver };
}

export interface DropOverlayProps {
  readonly visible: boolean;
  /** Display name of the folder files will be uploaded into. */
  readonly destinationName: string;
}

/**
 * Full-area overlay shown while an external file drag is over the current
 * folder: a dashed hairline border and a "Drop to upload to <folder>"
 * label. Purely presentational; pair with `useExternalDrop` for `visible`.
 */
export function DropOverlay({ visible, destinationName }: DropOverlayProps) {
  if (!visible) {
    return null;
  }

  return (
    <div
      role="presentation"
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/40 bg-background/85 backdrop-blur-sm duration-150 animate-in fade-in-0"
    >
      <p className="text-sm font-medium text-foreground">
        Drop to upload to <span className="font-semibold">{destinationName}</span>
      </p>
    </div>
  );
}
