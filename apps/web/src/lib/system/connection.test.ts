import type { AdminProvider, ProviderField } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";
import {
  connectionSourceLabel,
  enabledCapabilities,
  homeTemplatePreview,
  isPlausibleHomeTemplate,
  missingCapabilities,
  normalizeProviderConfig,
  providerAddressHint,
  providerAddressLock,
  providerConfigDraft,
  providerFormError,
  providerRemoveBlock,
  providerUpdatePatch,
} from "./connection";

const HOME_TEMPLATE_FIELD: ProviderField = {
  name: "homeTemplate",
  label: "Home template",
  kind: "text",
  required: false,
};
const TOKEN_FIELD: ProviderField = {
  name: "token",
  label: "API token",
  kind: "password",
  required: true,
};

const PROVIDER: AdminProvider = {
  id: "00000000-0000-4000-8000-000000000009",
  type: "sftpgo",
  label: "Primary",
  baseUrl: "http://sftpgo:8080",
  config: { homeTemplate: "sftpgo:/{username}" },
  enabled: true,
  managedByEnv: false,
  identityCount: 0,
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("connectionSourceLabel", () => {
  it("labels env as locked", () => {
    expect(connectionSourceLabel(true)).toBe("Environment (locked)");
  });

  it("labels settings as editable", () => {
    expect(connectionSourceLabel(false)).toBe("Settings");
  });
});

describe("isPlausibleHomeTemplate", () => {
  it.each([
    ["sftpgo:/{username}", true],
    ["sftpgo:/shared", true],
    ["sftpgo/{username}", false],
    [":/{username}", false],
    ["SFTPgo:/{username}", false],
    ["sftpgo:home/{username}", false],
  ])("template %s -> %s", (template, expected) => {
    expect(isPlausibleHomeTemplate(template)).toBe(expected);
  });
});

describe("homeTemplatePreview", () => {
  it.each([
    ["sftpgo:/{username}", "carol", "carol → sftpgo:/carol"],
    ["sftpgo:/{username}", "  ", "alice → sftpgo:/alice"],
    ["sftpgo:/{username}", "  carol  ", "carol → sftpgo:/carol"],
    ["sftpgo:/shared", "carol", "carol → sftpgo:/shared"],
  ])("preview for %s with user %s", (template, user, expected) => {
    expect(homeTemplatePreview(template, user)).toBe(expected);
  });
});

describe("providerConfigDraft", () => {
  it("prefills a saved value and blanks anything unset", () => {
    expect(
      providerConfigDraft([HOME_TEMPLATE_FIELD, TOKEN_FIELD], { homeTemplate: "sftpgo:/x" }),
    ).toEqual({ homeTemplate: "sftpgo:/x", token: "" });
  });

  it("blanks every field for a new provider", () => {
    expect(providerConfigDraft([HOME_TEMPLATE_FIELD])).toEqual({ homeTemplate: "" });
  });
});

describe("normalizeProviderConfig", () => {
  it("trims values and drops blank ones", () => {
    expect(normalizeProviderConfig({ homeTemplate: "  sftpgo:/x  ", token: "   " })).toEqual({
      homeTemplate: "sftpgo:/x",
    });
  });

  it("sorts keys so two equivalent configurations compare equal as JSON", () => {
    expect(JSON.stringify(normalizeProviderConfig({ b: "2", a: "1" }))).toBe(
      JSON.stringify(normalizeProviderConfig({ a: "1", b: "2" })),
    );
  });
});

describe("providerFormError", () => {
  const draft = { label: "Primary", baseUrl: "http://sftpgo:8080", config: {} };

  it("accepts a filled form", () => {
    expect(providerFormError([], draft)).toBeNull();
  });

  it("asks for a name", () => {
    expect(providerFormError([], { ...draft, label: "   " })).toBe(
      "Enter a name for this storage.",
    );
  });

  it("asks for an http(s) address", () => {
    expect(providerFormError([], { ...draft, baseUrl: "sftpgo:8080" })).toMatch(/http\(s\) URL/);
  });

  it("asks for a required configuration field", () => {
    expect(providerFormError([TOKEN_FIELD], { ...draft, config: { token: " " } })).toBe(
      "Enter api token.",
    );
  });

  it("accepts a filled required configuration field", () => {
    expect(providerFormError([TOKEN_FIELD], { ...draft, config: { token: "t" } })).toBeNull();
  });

  it("accepts an empty optional home template", () => {
    expect(providerFormError([HOME_TEMPLATE_FIELD], { ...draft, config: {} })).toBeNull();
  });

  it("rejects a home template that cannot parse", () => {
    expect(
      providerFormError([HOME_TEMPLATE_FIELD], { ...draft, config: { homeTemplate: "nonsense" } }),
    ).toBe('The home template is written as "<root>:<path>".');
  });
});

describe("providerUpdatePatch", () => {
  const draft = {
    label: PROVIDER.label,
    baseUrl: PROVIDER.baseUrl,
    config: { homeTemplate: "sftpgo:/{username}" },
  };

  it.each([
    ["sends nothing when nothing changed", draft, true, {}],
    [
      "sends trimmed label when name changed",
      { ...draft, label: "  Renamed  " },
      true,
      { label: "Renamed" },
    ],
    [
      "sends address when allowed",
      { ...draft, baseUrl: "http://other:8080" },
      true,
      { baseUrl: "http://other:8080" },
    ],
    ["omits address when not allowed", { ...draft, baseUrl: "http://other:8080" }, false, {}],
    [
      "sends whole configuration on field change",
      { ...draft, config: { homeTemplate: "sftpgo:/h/{username}" } },
      true,
      { config: { homeTemplate: "sftpgo:/h/{username}" } },
    ],
    [
      "sends empty configuration on optional field clear",
      { ...draft, config: { homeTemplate: "" } },
      true,
      { config: {} },
    ],
  ])("%s", (_name, modifiedDraft, allowEdit, expected) => {
    expect(providerUpdatePatch(PROVIDER, modifiedDraft, allowEdit)).toEqual(expected);
  });
});

describe("providerAddressLock", () => {
  it("names the environment variable for an env-managed provider", () => {
    expect(providerAddressLock({ ...PROVIDER, managedByEnv: true })).toBe(
      "Set by the deployment. Remove SFTPGO_URL to manage the address here.",
    );
  });

  it("explains that logins are bound to the address they were verified against", () => {
    expect(providerAddressLock({ ...PROVIDER, identityCount: 2 })).toBe(
      "Logins already use this server. Add a new provider for another address.",
    );
  });

  it("allows editing an unused, settings-managed address", () => {
    expect(providerAddressLock(PROVIDER)).toBeNull();
  });
});

describe("providerAddressHint", () => {
  it("tells an S3 address to carry the bucket in its path", () => {
    const hint = providerAddressHint("s3");
    expect(hint.example).toBe("https://s3.example.com/bucket");
    expect(hint.description).toContain("bucket in its path");
  });

  it("describes a WebDAV URL and falls back to the SFTPGo example", () => {
    expect(providerAddressHint("webdav").description).toContain("WebDAV");
    expect(providerAddressHint("sftpgo").example).toBe("http://sftpgo:8080");
    expect(providerAddressHint("").example).toBe("http://sftpgo:8080");
  });
});

describe("providerRemoveBlock", () => {
  it("blocks an env-managed provider", () => {
    expect(providerRemoveBlock({ ...PROVIDER, managedByEnv: true })).toMatch(/SFTPGO_URL/);
  });

  it("blocks a provider with logins", () => {
    expect(providerRemoveBlock({ ...PROVIDER, identityCount: 1 })).toMatch(/Logins still use/);
  });

  it("allows removing an unused, settings-managed provider", () => {
    expect(providerRemoveBlock(PROVIDER)).toBeNull();
  });
});

describe("enabledCapabilities", () => {
  it("keeps only the capabilities the type has, in a stable order", () => {
    expect(enabledCapabilities({ ...allCapabilities(false), trash: true, zip: true })).toEqual([
      "zip",
      "trash",
    ]);
  });

  it("is empty when the type can do none of them", () => {
    expect(enabledCapabilities(allCapabilities(false))).toEqual([]);
  });
});

describe("missingCapabilities", () => {
  it("keeps only the capabilities the type lacks, in a stable order", () => {
    expect(missingCapabilities({ ...allCapabilities(true), index: false, shares: false })).toEqual([
      "shares",
      "index",
    ]);
  });

  it("is empty when the type can do all of them", () => {
    expect(missingCapabilities(allCapabilities(true))).toEqual([]);
  });
});
