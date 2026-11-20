import { describe, expect, it } from "vitest";
import { makeMe } from "@/test-fixtures/identity";
import {
  FIRST_SETTINGS_SECTION,
  isSettingsIndex,
  SETTINGS_ROUTE,
  SETTINGS_SECTIONS,
  settingsSectionFor,
  settingsSectionsFor,
} from "./sections";

describe("SETTINGS_SECTIONS", () => {
  it("gives every section its own URL under /account, with Appearance first", () => {
    expect(SETTINGS_SECTIONS.map((section) => [section.id, section.href])).toEqual([
      ["appearance", "/account/appearance"],
      ["browsing", "/account/browsing"],
      ["formats", "/account/formats"],
      ["password", "/account/password"],
      ["encryption", "/account/encryption"],
      ["tokens", "/account/tokens"],
    ]);
    expect(FIRST_SETTINGS_SECTION.id).toBe("appearance");
    expect(SETTINGS_ROUTE).toBe("/account");
  });

  it("describes every section in one line", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
      expect(section.description).not.toContain("\n");
    }
  });
});

describe("settingsSectionsFor", () => {
  it("lists every section while the account loads and where encrypted folders are on", () => {
    expect(settingsSectionsFor(undefined)).toBe(SETTINGS_SECTIONS);
    expect(settingsSectionsFor(makeMe())).toBe(SETTINGS_SECTIONS);
  });

  it("leaves Encryption out on an installation without encrypted folders", () => {
    const ids = settingsSectionsFor(makeMe({ encryptedFolders: false })).map(({ id }) => id);
    expect(ids).toEqual(["appearance", "browsing", "formats", "password", "tokens"]);
  });
});

describe("isSettingsIndex", () => {
  it("is true on /account alone", () => {
    expect(isSettingsIndex("/account")).toBe(true);
    expect(isSettingsIndex("/account/")).toBe(true);
    expect(isSettingsIndex("/account/appearance")).toBe(false);
    expect(isSettingsIndex("/accounts")).toBe(false);
    expect(isSettingsIndex(null)).toBe(false);
  });
});

describe("settingsSectionFor", () => {
  it("finds the section a URL shows", () => {
    expect(settingsSectionFor("/account/tokens").id).toBe("tokens");
    expect(settingsSectionFor("/account/encryption").id).toBe("encryption");
    expect(settingsSectionFor("/account/formats/").id).toBe("formats");
  });

  it("falls back to the first section on /account, an unknown path and no path", () => {
    expect(settingsSectionFor("/account")).toBe(FIRST_SETTINGS_SECTION);
    expect(settingsSectionFor("/account/nope")).toBe(FIRST_SETTINGS_SECTION);
    expect(settingsSectionFor("/account/formatsx")).toBe(FIRST_SETTINGS_SECTION);
    expect(settingsSectionFor(null)).toBe(FIRST_SETTINGS_SECTION);
  });
});
