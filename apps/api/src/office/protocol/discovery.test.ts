import { describe, expect, it } from "vitest";
import { buildActionUrl, parseDiscovery, selectDiscoveryAction } from "./discovery.ts";
import { officialKeys } from "./proof-vectors.fixture.ts";

const xml = `<wopi-discovery><net-zone name="external-https"><app name="Word"><action ext="docx" name="view" urlsrc="https://office/view?&lt;ui=UI_LLCC&amp;&gt;"/><action ext="docx" name="edit" urlsrc="https://office/edit?x=1&amp;&lt;ui=UI_LLCC&amp;&gt;"/></app></net-zone><proof-key modulus="${officialKeys.modulus}" exponent="AQAB" oldmodulus="${officialKeys.oldmodulus}" oldexponent="AQAB"/></wopi-discovery>`;

describe("discovery", () => {
  it("parses keys and selects edit even when view is first", () => {
    const discovery = parseDiscovery(xml);
    expect(discovery.proofKeys).toEqual({
      current: { modulus: officialKeys.modulus, exponent: "AQAB" },
      old: { modulus: officialKeys.oldmodulus, exponent: "AQAB" },
    });
    expect(selectDiscoveryAction(discovery, ".DOCX", "edit")?.url).toBe(
      "https://office/edit?x=1&<ui=UI_LLCC&>",
    );
    expect(selectDiscoveryAction(discovery, "docx", "view", "external-https")?.name).toBe("view");
    expect(selectDiscoveryAction(discovery, "docx", "edit", "internal-http")).toBeUndefined();
    expect(selectDiscoveryAction(discovery, "xlsx", "edit")).toBeUndefined();
    expect(selectDiscoveryAction(discovery, "docx", "convert")).toBeUndefined();
  });
  it("allows current key only and empty-extension MIME actions", () => {
    const discovery = parseDiscovery(
      xml.replace(/ oldmodulus="[^"]*" oldexponent="[^"]*"/, "").replaceAll('ext="docx"', 'ext=""'),
    );
    expect(discovery.proofKeys.old).toBeUndefined();
    expect(selectDiscoveryAction(discovery, "", "view")?.extension).toBe("");
  });
  it.each([
    "<!DOCTYPE a><a/>",
    "<!ENTITY a 'x'><a/>",
    "<broken>",
    "<a/>",
    xml.replace(' oldexponent="AQAB"', ""),
    xml.replace(/ oldmodulus="[^"]*"/, ""),
    xml.replace('exponent="AQAB"', 'exponent="bad"'),
    xml.replaceAll("https://office/", "javascript:office/"),
    xml.replaceAll("https://office/", "https://user:pass@office/"),
    xml.replace(/<action[^>]*\/>/g, ""),
  ])("rejects malformed or unsafe XML", (value) => expect(() => parseDiscovery(value)).toThrow());
  it("rejects a document whose action list is empty", () => {
    // Empty arrays are reachable when a zone has no app children represented as an empty array.
    expect(() => parseDiscovery(xml.replace(/<app.*<\/app>/, ""))).toThrow();
  });
});

describe("action URLs", () => {
  const source = "https://api/wopi/files/1?other=å&x=+";
  it("fills documented placeholders, removes others, preserves query bytes", () => {
    const template =
      "https://office/edit?token=a%20b+%2f&<ui=UI_LLCC&><rs=DC_LLCC&><thm=THEME_ID&><dchat=DISABLE_CHAT&><unsupported=X&>";
    expect(
      buildActionUrl(template, source, { ui: "sv se", rs: "sv-se", thm: "2", dchat: "1" }),
    ).toBe(
      `https://office/edit?token=a%20b+%2f&ui=sv%20se&rs=sv-se&thm=2&dchat=1&WOPISrc=${encodeURIComponent(source)}`,
    );
  });
  it.each(["https://office/edit", "https://office/edit?", "https://office/edit?<ui=UI&>"])(
    "appends to %s",
    (template) => {
      expect(buildActionUrl(template, source)).toBe(
        `https://office/edit?WOPISrc=${encodeURIComponent(source)}`,
      );
    },
  );
  it("adds an ampersand to an existing final query value", () => {
    expect(buildActionUrl("https://office/edit?x=1", source)).toContain("?x=1&WOPISrc=");
  });
  it.each([
    "javascript:alert(1)",
    "https://office/edit#fragment",
    "https://office/edit?wopisrc=old",
    "https://office/edit?WOPISrc=old",
    "relative",
    "https://office/\nedit",
  ])("rejects unsafe or duplicate template %s", (template) => {
    expect(() => buildActionUrl(template, source)).toThrow();
  });
  it("rejects an unsafe callback", () =>
    expect(() => buildActionUrl("https://office", "file:///x")).toThrow());
});
