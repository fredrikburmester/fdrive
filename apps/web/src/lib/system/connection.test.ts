import type { AdminProvider, ProviderField } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";
import {
  connectionSourceLabel,
  enabledCapabilities,
  hasAddress,
  LOCAL_FOLDER_NOTE,
  missingCapabilities,
  normalizeProviderConfig,
  providerAddressHint,
  providerAddressLock,
  providerConfigDraft,
  providerFormError,
  providerRemoveBlock,
  providerUpdatePatch,
} from "./connection";

const PREFIX_FIELD: ProviderField = {
  name: "prefix",
  label: "Folder prefix",
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
  type: "webdav",
  label: "Primary",
  baseUrl: "https://dav.example.com/",
  config: { prefix: "/files" },
  enabled: true,
  managedByEnv: false,
  identityCount: 0,
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  capabilities: allCapabilities(false),
};

const FOLDER: AdminProvider = {
  ...PROVIDER,
  id: "00000000-0000-4000-8000-00000000000a",
  type: "local",
  label: "Local folder",
  baseUrl: "",
  config: {},
  managedByEnv: true,
};

describe("connectionSourceLabel", () => {
  it("labels a deployment-pinned row as locked", () => {
    expect(connectionSourceLabel(true)).toBe("Deployment (locked)");
  });

  it("labels settings as editable", () => {
    expect(connectionSourceLabel(false)).toBe("Settings");
  });
});

describe("hasAddress", () => {
  it("is true for a provider reached at a URL", () => {
    expect(hasAddress(PROVIDER)).toBe(true);
  });

  it("is false for the local folder, which has none", () => {
    expect(hasAddress(FOLDER)).toBe(false);
    expect(LOCAL_FOLDER_NOTE).toBe("Folder on this server, set by FDRIVE_STORAGE_ROOT.");
  });
});

describe("providerConfigDraft", () => {
  it("prefills a saved value and blanks anything unset", () => {
    expect(providerConfigDraft([PREFIX_FIELD, TOKEN_FIELD], { prefix: "/x" })).toEqual({
      prefix: "/x",
      token: "",
    });
  });

  it("blanks every field for a new provider", () => {
    expect(providerConfigDraft([PREFIX_FIELD])).toEqual({ prefix: "" });
  });
});

describe("normalizeProviderConfig", () => {
  it("trims values and drops blank ones", () => {
    expect(normalizeProviderConfig({ prefix: "  /x  ", token: "   " })).toEqual({
      prefix: "/x",
    });
  });

  it("sorts keys so two equivalent configurations compare equal as JSON", () => {
    expect(JSON.stringify(normalizeProviderConfig({ b: "2", a: "1" }))).toBe(
      JSON.stringify(normalizeProviderConfig({ a: "1", b: "2" })),
    );
  });
});

describe("providerFormError", () => {
  const draft = { label: "Primary", baseUrl: "https://dav.example.com/", config: {} };

  it("accepts a filled form", () => {
    expect(providerFormError([], draft)).toBeNull();
  });

  it("asks for a name", () => {
    expect(providerFormError([], { ...draft, label: "   " })).toBe(
      "Enter a name for this storage.",
    );
  });

  it("asks for an http(s) address", () => {
    expect(providerFormError([], { ...draft, baseUrl: "dav.example.com" })).toBe(
      "Enter the address as an http(s) URL.",
    );
  });

  it("does not ask the local folder for an address", () => {
    expect(providerFormError([], { ...draft, baseUrl: "" }, false)).toBeNull();
    expect(providerFormError([], { ...draft, label: "", baseUrl: "" }, false)).toBe(
      "Enter a name for this storage.",
    );
  });

  it("asks for a required configuration field", () => {
    expect(providerFormError([TOKEN_FIELD], { ...draft, config: { token: " " } })).toBe(
      "Enter api token.",
    );
  });

  it("accepts a filled required field and an empty optional one", () => {
    expect(
      providerFormError([TOKEN_FIELD, PREFIX_FIELD], { ...draft, config: { token: "t" } }),
    ).toBe(null);
  });
});

describe("providerUpdatePatch", () => {
  const draft = {
    label: PROVIDER.label,
    baseUrl: PROVIDER.baseUrl,
    config: { prefix: "/files" },
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
      { ...draft, baseUrl: "https://other.example.com/" },
      true,
      { baseUrl: "https://other.example.com/" },
    ],
    [
      "omits address when not allowed",
      { ...draft, baseUrl: "https://other.example.com/" },
      false,
      {},
    ],
    [
      "sends whole configuration on field change",
      { ...draft, config: { prefix: "/media" } },
      true,
      { config: { prefix: "/media" } },
    ],
    [
      "sends empty configuration on optional field clear",
      { ...draft, config: { prefix: "" } },
      true,
      { config: {} },
    ],
  ])("%s", (_name, modifiedDraft, allowEdit, expected) => {
    expect(providerUpdatePatch(PROVIDER, modifiedDraft, allowEdit)).toEqual(expected);
  });
});

describe("providerAddressLock", () => {
  it("locks a row the deployment pins", () => {
    expect(providerAddressLock(FOLDER)).toBe("Set by the deployment, so it cannot change here.");
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

  it("describes a WebDAV URL and falls back to a generic example", () => {
    expect(providerAddressHint("webdav").description).toContain("WebDAV");
    expect(providerAddressHint("").example).toBe("https://storage.example.com/");
    expect(providerAddressHint("").description).toBe(
      "Where fdrive reaches this storage, such as https://storage.example.com/.",
    );
  });
});

describe("providerRemoveBlock", () => {
  it("blocks the deployment's own folder", () => {
    expect(providerRemoveBlock(FOLDER)).toBe(
      "Set by the deployment with FDRIVE_STORAGE_ROOT, so it cannot be removed here.",
    );
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
