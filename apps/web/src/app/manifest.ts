import type { MetadataRoute } from "next";

/**
 * Web app manifest for installing fdrive to a phone's home screen.
 *
 * `name`/`short_name` are what iOS and Android print under the icon; without
 * a manifest (and without `apple-icon.png`) iOS falls back to a screenshot of
 * the page and a guessed label, which is why an installed shortcut used to
 * show the wrong letter.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "fdrive",
    short_name: "fdrive",
    description: "fdrive",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#000000",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
