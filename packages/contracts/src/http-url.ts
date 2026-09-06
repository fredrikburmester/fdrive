import { z } from "zod";

/**
 * True when `value` parses as an absolute URL whose protocol is http or
 * https. Mirrors the equivalent check in `apps/api`'s config loader, kept
 * here too so contract schemas can validate the same shape independently
 * of any one consumer.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A non-empty string that must be an absolute http(s) URL. */
export const HttpUrl = z.string().min(1).refine(isHttpUrl, { message: "must be an http(s) URL" });

export type HttpUrl = z.infer<typeof HttpUrl>;
