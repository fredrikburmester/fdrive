/**
 * Rules shared by every window-level keyboard shortcut in the app. Feature
 * keymaps (which key means what) stay next to their feature, in
 * `lib/files/keyboard.ts` and `lib/editor/keymap.ts`; what lives here is the
 * part each of those global listeners has to get right in the same way.
 */

/**
 * `<input>` types that hold no text and show no caret, so a keystroke aimed
 * at one is not text entry. Every other type — including the ones a browser
 * does not recognize, which it renders (and reports through `input.type`)
 * as "text" — accepts typing or arrow-key editing of a value.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * True when `element` sits in a `contenteditable` region. Browsers resolve
 * the inherited value onto `isContentEditable`, which is the authoritative
 * answer; jsdom implements neither that property nor `contentEditable`, so
 * the nearest ancestor carrying the attribute is consulted instead. Only
 * that nearest one counts: a `contenteditable="false"` island (the value is
 * matched case-insensitively, as HTML does) opts its own subtree back out
 * of an editable host.
 */
function isInContentEditable(element: Element): boolean {
  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }
  const host = element.closest("[contenteditable]");
  return host !== null && !host.matches("[contenteditable='false' i]");
}

/**
 * True when a keyboard event's `target` is a text-entry surface: a text-like
 * `<input>`, a `<textarea>`, a `<select>` (whose arrow keys change the
 * selected option), or anything inside a `contenteditable` region.
 *
 * Global shortcut listeners call this and return early, so that typing in a
 * field never also triggers a page-level shortcut. Non-text controls that
 * happen to use arrow keys (a range slider, a radio group) are deliberately
 * not covered: nothing typed is lost there, and a listener that must yield
 * to them can check for that itself.
 *
 * `target` is whatever the event carries, which is not always an element:
 * keystrokes that reach no element are targeted at the document or the
 * window, and a synthetic event may carry `null`.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  return isInContentEditable(target);
}
