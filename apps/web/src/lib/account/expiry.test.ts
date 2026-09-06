import { describe, expect, it } from "vitest";
import { EXPIRY_OPTIONS, expiresInDaysFromOptionValue } from "./expiry";

describe("EXPIRY_OPTIONS", () => {
  it("offers 30, 90, 365 days, and never", () => {
    expect(EXPIRY_OPTIONS.map((option) => option.value)).toEqual(["30", "90", "365", "never"]);
  });
});

describe("expiresInDaysFromOptionValue", () => {
  it("maps '30' to 30", () => {
    expect(expiresInDaysFromOptionValue("30")).toBe(30);
  });

  it("maps '90' to 90", () => {
    expect(expiresInDaysFromOptionValue("90")).toBe(90);
  });

  it("maps '365' to 365", () => {
    expect(expiresInDaysFromOptionValue("365")).toBe(365);
  });

  it("maps 'never' to undefined", () => {
    expect(expiresInDaysFromOptionValue("never")).toBeUndefined();
  });

  it("maps an unrecognized value to undefined", () => {
    expect(expiresInDaysFromOptionValue("bogus")).toBeUndefined();
  });
});
