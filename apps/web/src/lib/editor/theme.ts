/**
 * The monospace font stack for the editor, matching the code preview's
 * convention.
 */
export const EDITOR_FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, monospace';

/**
 * A plain data description of `EditorView.theme`'s style spec, built here
 * (rather than inline where `EditorView.theme` is called) so it can be unit
 * tested without importing CodeMirror. Every color reads a CSS custom
 * property from `globals.css`, so the editor follows the app's light/dark
 * theme (the `.dark` class on `<html>`) automatically: the browser
 * re-resolves `var(...)` at paint time, no CodeMirror-side dark/light
 * switching is needed.
 */
export function editorThemeSpec(): Record<string, Record<string, string>> {
  return {
    "&": {
      color: "var(--foreground)",
      backgroundColor: "var(--background)",
      fontFamily: EDITOR_FONT_FAMILY,
      fontSize: "13px",
      height: "100%",
    },
    ".cm-content": {
      caretColor: "var(--foreground)",
      fontFamily: EDITOR_FONT_FAMILY,
      padding: "0.75rem 0",
    },
    ".cm-scroller": {
      fontFamily: EDITOR_FONT_FAMILY,
    },
    ".cm-gutters": {
      backgroundColor: "var(--background)",
      color: "var(--muted-foreground)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--muted)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--muted)",
    },
    ".cm-selectionBackground": {
      backgroundColor: "var(--accent)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--foreground)",
    },
    "&.cm-focused": {
      outline: "none",
    },
  };
}
