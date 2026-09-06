import type { Extension } from "@codemirror/state";

/**
 * The CodeMirror language packages the editor knows how to load, plus
 * "none" for extensions with no dedicated language support (still edited
 * as plain text).
 */
export type LanguageKey =
  | "markdown"
  | "javascript"
  | "json"
  | "css"
  | "html"
  | "python"
  | "yaml"
  | "none";

const LANGUAGE_KEY_BY_EXTENSION: Readonly<Record<string, LanguageKey>> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "javascript",
  ".tsx": "javascript",
  ".json": "json",
  ".css": "css",
  ".scss": "css",
  ".html": "html",
  ".htm": "html",
  ".py": "python",
  ".yml": "yaml",
  ".yaml": "yaml",
};

/**
 * Picks the CodeMirror language package for a file extension (with leading
 * dot, case-insensitive). TypeScript and JSX variants all map to
 * "javascript": `@codemirror/lang-javascript`'s `javascript()` support
 * handles JSX and TypeScript syntax through its own options, so a single
 * package covers the whole family. Falls back to "none" (plain text, no
 * syntax highlighting) for anything else.
 */
export function languageKeyFor(ext: string): LanguageKey {
  return LANGUAGE_KEY_BY_EXTENSION[ext.toLowerCase()] ?? "none";
}

/**
 * Loads the CodeMirror extensions for `key` via a dynamic import, so each
 * language package is only ever pulled into the bundle when a file of that
 * kind is actually opened. Returns an empty array for "none".
 */
export async function loadLanguageExtension(key: LanguageKey): Promise<Extension[]> {
  switch (key) {
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return [markdown()];
    }
    case "javascript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return [javascript({ jsx: true, typescript: true })];
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return [json()];
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return [css()];
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      return [html()];
    }
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return [python()];
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return [yaml()];
    }
    case "none":
      return [];
  }
}
