import { ProviderType } from "@fdrive/contracts";
import { expect, it } from "vitest";
import { PROVIDER_TYPE_LABELS, providerTypeLabel } from "./provider-type";

it("names every provider type the contracts know", () => {
  for (const type of ProviderType.options) {
    expect(PROVIDER_TYPE_LABELS[type].length).toBeGreaterThan(0);
    expect(providerTypeLabel(type)).toBe(PROVIDER_TYPE_LABELS[type]);
  }
});

it("falls back to the raw type for one this build does not know", () => {
  expect(providerTypeLabel("s3")).toBe("s3");
});
