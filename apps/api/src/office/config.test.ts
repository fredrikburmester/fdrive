import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { officeConfig } from "./config.ts";

const base = {
  DATABASE_URL: "postgres://unused",
  FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const office = {
  FDRIVE_OFFICE_PRODUCT: "onlyoffice",
  FDRIVE_OFFICE_URL: "http://internal",
  FDRIVE_OFFICE_PUBLIC_URL: "https://app/office",
  FDRIVE_WOPI_URL: "http://api/wopi",
};
describe("office configuration", () => {
  it("uses bundled runtime defaults with a persisted browser origin", () => {
    const bundled = loadConfig(base);
    expect(officeConfig(bundled, "https://drive.example/")).toMatchObject({
      product: "onlyoffice",
      serverUrl: "http://onlyoffice",
      publicUrl: "https://drive.example/onlyoffice",
      wopiUrl: "http://api:3001/wopi",
      appUrl: "https://drive.example",
    });
    const config = loadConfig({ ...base, ...office });
    expect(officeConfig(config, "https://drive.example").maxBytes).toBe(104857600);
    expect(
      officeConfig({ ...config, fdriveOfficeMaxBytes: undefined }, "https://drive.example")
        .maxBytes,
    ).toBe(104857600);
    expect(
      loadConfig({ ...base, ...office, FDRIVE_OFFICE_MAX_BYTES: "10" }).fdriveOfficeMaxBytes,
    ).toBe(10);
  });
  it("requires explicit Collabora server and public endpoint overrides", () => {
    expect(() => loadConfig({ ...base, FDRIVE_OFFICE_PRODUCT: "collabora" })).toThrow(
      /Collabora requires/,
    );
    expect(() =>
      loadConfig({
        ...base,
        FDRIVE_OFFICE_PRODUCT: "collabora",
        FDRIVE_OFFICE_URL: "http://collabora",
        FDRIVE_OFFICE_PUBLIC_URL: "https://office.example",
      }),
    ).not.toThrow();
  });
  it("accepts partial infrastructure overrides without activating Office", () => {
    const config = loadConfig({
      ...base,
      FDRIVE_OFFICE_PRODUCT: "onlyoffice",
      FDRIVE_OFFICE_URL: "http://onlyoffice",
      FDRIVE_WOPI_URL: "http://api:3001/wopi",
    });
    expect(officeConfig(config, "https://drive.example")).toMatchObject({
      publicUrl: "https://drive.example/onlyoffice",
    });
  });
  it.each(["0", "-1", "1.2", "1073741825", "9007199254740992"])("rejects max bytes %s", (value) =>
    expect(() => loadConfig({ ...base, FDRIVE_OFFICE_MAX_BYTES: value })).toThrow(),
  );
  it.each([
    "file:///x",
    "https://user:secret@office",
    "https://office?q=1",
    "https://office#x",
    "https://off\nice",
  ])("rejects unsafe office URL", (value) =>
    expect(() => loadConfig({ ...base, ...office, FDRIVE_OFFICE_URL: value })).toThrow(),
  );
  it("requires a callback /wopi suffix and known product", () => {
    expect(() =>
      loadConfig({ ...base, ...office, FDRIVE_WOPI_URL: "http://api/callback" }),
    ).toThrow();
    expect(() => loadConfig({ ...base, ...office, FDRIVE_OFFICE_PRODUCT: "other" })).toThrow();
  });
});

it("rejects invalid runtime endpoint snapshots before issuing editor URLs", () => {
  const config = loadConfig(base);
  expect(() =>
    officeConfig(
      { ...config, fdriveOfficeUrl: "http://office?unexpected=1" },
      "https://drive.example",
    ),
  ).toThrow("Office URLs cannot contain queries");
  expect(() =>
    officeConfig({ ...config, fdriveWopiUrl: "http://api/other" }, "https://drive.example"),
  ).toThrow("FDRIVE_WOPI_URL must end in /wopi");
});
