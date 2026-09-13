#!/usr/bin/env node
// Reuse the web SVG as the source for all native branding. Requires pnpm install.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const sharp = createRequire(webRequire.resolve("next/package.json"))("sharp");
const assets = new URL("../../apps/macos/App/Assets.xcassets/", import.meta.url);
const svg = await readFile(new URL("../../apps/web/src/app/icon.svg", import.meta.url));
const metadata = { author: "xcode", version: 1 };
const saveJSON = (url, value) => writeFile(url, `${JSON.stringify(value, null, 2)}\n`);
await mkdir(new URL("AppIcon.appiconset/", assets), { recursive: true });
await saveJSON(new URL("Contents.json", assets), { info: metadata });

const images = [];
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = size * scale;
    const inset = Math.round(pixels * 0.1);
    const filename = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
    await sharp(svg, { density: 288 })
      .resize(pixels - 2 * inset)
      .extend({ top: inset, bottom: inset, left: inset, right: inset, background: "#00000000" })
      .png()
      .toFile(fileURLToPath(new URL(`AppIcon.appiconset/${filename}`, assets)));
    images.push({ idiom: "mac", size: `${size}x${size}`, scale: `${scale}x`, filename });
  }
}
await saveJSON(new URL("AppIcon.appiconset/Contents.json", assets), { images, info: metadata });

// A template uses the same white monogram as its alpha mask, so macOS controls menu-bar color.
await mkdir(new URL("MenuBarIcon.imageset/", assets), { recursive: true });
const menuImages = [];
const monogram = Buffer.from(
  svg.toString().replace('viewBox="0 0 512 512"', 'viewBox="104 140 298 232"'),
);
for (const scale of [1, 2]) {
  const pixels = 18 * scale;
  const alpha = await sharp(monogram, { density: 288 })
    .resize(pixels, pixels, { fit: "contain", background: "#000000" })
    .extractChannel(0)
    .raw()
    .toBuffer();
  const filename = `menubar${scale === 2 ? "@2x" : ""}.png`;
  await sharp({ create: { width: pixels, height: pixels, channels: 3, background: "#000000" } })
    .joinChannel(alpha, { raw: { width: pixels, height: pixels, channels: 1 } })
    .png()
    .toFile(fileURLToPath(new URL(`MenuBarIcon.imageset/${filename}`, assets)));
  menuImages.push({ idiom: "mac", scale: `${scale}x`, filename });
}
await saveJSON(new URL("MenuBarIcon.imageset/Contents.json", assets), {
  images: menuImages,
  info: metadata,
  properties: { "template-rendering-intent": "template" },
});
console.log("Generated macOS icons from apps/web/src/app/icon.svg");
