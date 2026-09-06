import type { Platform } from "./keyboard";

export interface NavigatorLike {
  readonly platform?: string;
  readonly userAgent?: string;
}

const MAC_PATTERN = /Mac|iPhone|iPad|iPod/;

/**
 * Detects whether `nav` describes a mac (so keyboard shortcuts should use
 * Cmd) or anything else (Ctrl). Falls back to "other" when `nav` is
 * `undefined` (server-side rendering, where there is no `navigator`).
 */
export function detectPlatform(nav: NavigatorLike | undefined): Platform {
  if (nav === undefined) {
    return "other";
  }
  const signal = nav.platform ?? nav.userAgent ?? "";
  return MAC_PATTERN.test(signal) ? "mac" : "other";
}
