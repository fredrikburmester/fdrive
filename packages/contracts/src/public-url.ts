import { z } from "zod";

/**
 * An http(s) origin: scheme, host and optional port, nothing else. Stored
 * normalised through `URL.origin`, so `https://drive.example/` and
 * `https://drive.example` are the same value.
 */
export const HttpOrigin = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "" || url.pathname === "/")
    );
  }, "must be an HTTP(S) origin without credentials, path, query, or fragment")
  .transform((value) => new URL(value).origin);

/**
 * The address everyone opens fdrive at, chosen by the owner in onboarding
 * (System > Features afterwards). The bundled Office editor is told this is
 * where fdrive lives, and MCP tool results link into it. `null` until set:
 * MCP links are then relative and Office cannot be enabled.
 */
export const PublicUrlSettings = z
  .object({
    revision: z.number().int().nonnegative(),
    url: HttpOrigin.nullable(),
  })
  .strict();
export type PublicUrlSettings = z.infer<typeof PublicUrlSettings>;

export const PublicUrlUpdateRequest = PublicUrlSettings;
export type PublicUrlUpdateRequest = z.infer<typeof PublicUrlUpdateRequest>;

export const PUBLIC_URL_SETTINGS_KEY = "system.publicUrl";
