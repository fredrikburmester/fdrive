/** True when the document's current text no longer matches its baseline. */
export function isDirty(baselineText: string, documentText: string): boolean {
  return baselineText !== documentText;
}

/**
 * The subset of `BeforeUnloadEvent` this module needs, so it can be unit
 * tested without a real browser event. A real `BeforeUnloadEvent` satisfies
 * this structurally.
 */
export interface BeforeUnloadEventLike {
  preventDefault(): void;
  returnValue: string;
}

/**
 * Applies the standard "are you sure you want to leave" browser prompt to
 * `event` when `dirty` is true, and does nothing otherwise. Most browsers
 * ignore the custom message and show their own generic text, but setting
 * both `preventDefault()` and `returnValue` covers the full range of
 * implementations.
 */
export function guardBeforeUnload(event: BeforeUnloadEventLike, dirty: boolean): void {
  if (!dirty) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
}
