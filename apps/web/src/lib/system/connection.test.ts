import type { AdminProvider, ProviderField } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";
import {
  connectionSourceLabel,
  enabledCapabilities,
  homeTemplatePreview,
  isPlausibleHomeTemplate,
  normalizeProviderConfig,
  providerAddressLock,
  providerConfigDraft,
  providerFormError,
  providerInputType,
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
  it("accepts the default template", () => {
    expect(isPlausibleHomeTemplate("sftpgo:/{username}")).toBe(true);
  });

  it("accepts a template without the placeholder", () => {
    expect(isPlausibleHomeTemplate("sftpgo:/shared")).toBe(true);
  });

  it("rejects a missing colon", () => {
    expect(isPlausibleHomeTemplate("sftpgo/{username}")).toBe(false);
  });

  it("rejects an empty root name", () => {
    expect(isPlausibleHomeTemplate(":/{username}")).toBe(false);
  });

  it("rejects an uppercase root name", () => {
    expect(isPlausibleHomeTemplate("SFTPgo:/{username}")).toBe(false);
  });

  it("rejects a path that does not start with a slash", () => {
    expect(isPlausibleHomeTemplate("sftpgo:home/{username}")).toBe(false);
  });
});

describe("homeTemplatePreview", () => {
  it("substitutes the given username", () => {
    expect(homeTemplatePreview("sftpgo:/{username}", "carol")).toBe("carol → sftpgo:/carol");
  });

  it("falls back to a placeholder username when blank", () => {
    expect(homeTemplatePreview("sftpgo:/{username}", "  ")).toBe("alice → sftpgo:/alice");
  });

  it("trims surrounding whitespace from the username", () => {
    expect(homeTemplatePreview("sftpgo:/{username}", "  carol  ")).toBe("carol → sftpgo:/carol");
  });

  it("leaves a template with no placeholder unchanged", () => {
    expect(homeTemplatePreview("sftpgo:/shared", "carol")).toBe("carol → sftpgo:/shared");
  });
});

describe("providerInputType", () => {
  it("maps password fields to a masked input", () => {
    expect(providerInputType("password")).toBe("password");
  });

  it("maps url fields to a url input", () => {
    expect(providerInputType("url")).toBe("url");
  });

  it("falls back to text for the remaining kinds", () => {
    expect(providerInputType("text")).toBe("text");
    expect(providerInputType("otp")).toBe("text");
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
    expect(providerFormError([], { ...draft, label: "   " })).toBe("Enter a name for this server.");
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

  it("sends nothing when nothing changed", () => {
    expect(providerUpdatePatch(PROVIDER, draft, true)).toEqual({});
  });

  it("sends only the trimmed label when only the name changed", () => {
    expect(providerUpdatePatch(PROVIDER, { ...draft, label: "  Renamed  " }, true)).toEqual({
      label: "Renamed",
    });
  });

  it("sends the address when it changed and the form may edit it", () => {
    expect(providerUpdatePatch(PROVIDER, { ...draft, baseUrl: "http://other:8080" }, true)).toEqual(
      {
        baseUrl: "http://other:8080",
      },
    );
  });

  it("omits the address when the form may not edit it", () => {
    expect(
      providerUpdatePatch(PROVIDER, { ...draft, baseUrl: "http://other:8080" }, false),
    ).toEqual({});
  });

  it("sends the whole configuration when one field changed", () => {
    expect(
      providerUpdatePatch(
        PROVIDER,
        { ...draft, config: { homeTemplate: "sftpgo:/h/{username}" } },
        true,
      ),
    ).toEqual({ config: { homeTemplate: "sftpgo:/h/{username}" } });
  });

  it("sends an empty configuration when an optional field was cleared", () => {
    expect(providerUpdatePatch(PROVIDER, { ...draft, config: { homeTemplate: "" } }, true)).toEqual(
      {
        config: {},
      },
    );
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
