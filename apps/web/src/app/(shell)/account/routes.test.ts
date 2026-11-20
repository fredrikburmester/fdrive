import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SETTINGS_ROUTE, SETTINGS_SECTIONS } from "@/components/account/sections";

/** This folder, `app/(shell)/account/`, whose subfolders are the Settings routes. */
const here = fileURLToPath(new URL(".", import.meta.url));

it("has one page per Settings section, and no page the section list does not know", () => {
  const folders = readdirSync(here, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  expect(folders.map((name) => `${SETTINGS_ROUTE}/${name}`).sort()).toEqual(
    SETTINGS_SECTIONS.map((section) => String(section.href)).sort(),
  );
  for (const name of folders) {
    expect(existsSync(`${here}${name}/page.tsx`)).toBe(true);
  }
});

it("frames every page in one layout, with a page for /account itself", () => {
  expect(existsSync(`${here}layout.tsx`)).toBe(true);
  expect(existsSync(`${here}page.tsx`)).toBe(true);
});
