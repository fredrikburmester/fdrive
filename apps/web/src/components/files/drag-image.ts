/**
 * Builds a small offscreen element to use as a drag's custom image via
 * `dataTransfer.setDragImage`: the item's name with a count badge when more
 * than one item is being dragged, matching Finder. Callers must append the
 * returned element to the document before calling `setDragImage`, then
 * remove it once the current task finishes (a `setTimeout(fn, 0)` is
 * enough): the browser only needs the element to exist at the moment
 * `setDragImage` runs, not for the rest of the drag.
 */
export function createDragImageElement(doc: Document, label: string, count: number): HTMLElement {
  const element = doc.createElement("div");
  element.className =
    "pointer-events-none fixed left-[-9999px] top-[-9999px] flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-sm";

  const labelSpan = doc.createElement("span");
  labelSpan.className = "max-w-40 truncate";
  labelSpan.textContent = label;
  element.appendChild(labelSpan);

  if (count > 1) {
    const badge = doc.createElement("span");
    badge.className =
      "flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground";
    badge.textContent = String(count);
    element.appendChild(badge);
  }

  doc.body.appendChild(element);
  return element;
}
