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
  FDRIVE_PUBLIC_URL: "https://app",
};
describe("office configuration", () => {
  it("is optional and validates a complete tuple", () => {
    expect(officeConfig(loadConfig(base))).toBeNull();
    const config = loadConfig({ ...base, ...office });
    expect(officeConfig(config)?.maxBytes).toBe(104857600);
    expect(officeConfig({ ...config, fdriveOfficeMaxBytes: undefined })?.maxBytes).toBe(104857600);
    expect(
      loadConfig({ ...base, ...office, FDRIVE_OFFICE_MAX_BYTES: "10" }).fdriveOfficeMaxBytes,
    ).toBe(10);
  });
  it.each(Object.keys(office))("requires %s with the other office fields", (key) => {
    expect(() => loadConfig({ ...base, ...office, [key]: undefined })).toThrow();
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
