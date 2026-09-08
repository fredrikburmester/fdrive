import { describe, expect, it } from "vitest";
import { FeatureConfiguration, FeaturesUpdateRequest } from "./features.ts";

const values = {
  thumbnails: false,
  textSearch: false,
  searchOcr: false,
  semanticSearch: false,
  imageSearch: false,
  pdfOcr: false,
};
describe("feature contracts", () => {
  it("requires indexing for search OCR and semantics, but keeps PDF conversion independent", () => {
    const input = { revision: 0, values, walkthroughComplete: false };
    expect(FeaturesUpdateRequest.safeParse(input).success).toBe(true);
    for (const feature of ["searchOcr", "semanticSearch"]) {
      expect(
        FeaturesUpdateRequest.safeParse({ ...input, values: { ...values, [feature]: true } })
          .success,
      ).toBe(false);
      expect(
        FeaturesUpdateRequest.safeParse({
          ...input,
          values: { ...values, textSearch: true, [feature]: true },
        }).success,
      ).toBe(true);
    }
    expect(
      FeaturesUpdateRequest.safeParse({ ...input, values: { ...values, pdfOcr: true } }).success,
    ).toBe(true);
    expect(
      FeaturesUpdateRequest.safeParse({ ...input, values: { ...values, imageSearch: true } })
        .success,
    ).toBe(true);
  });
  it("validates schema version, revision, resumable step and strict switches", () => {
    const input = {
      version: 1,
      revision: 0,
      values,
      walkthroughComplete: false,
      walkthroughStep: 6,
    };
    expect(FeatureConfiguration.safeParse(input).success).toBe(true);
    expect(FeatureConfiguration.safeParse({ ...input, version: 2 }).success).toBe(false);
    expect(FeatureConfiguration.safeParse({ ...input, revision: -1 }).success).toBe(false);
    expect(FeatureConfiguration.safeParse({ ...input, walkthroughStep: 7 }).success).toBe(true);
    expect(FeatureConfiguration.safeParse({ ...input, walkthroughStep: 8 }).success).toBe(true);
    expect(FeatureConfiguration.safeParse({ ...input, walkthroughStep: 9 }).success).toBe(false);
    const update = { revision: 0, values, walkthroughComplete: false, walkthroughStep: 8 };
    expect(FeaturesUpdateRequest.safeParse(update).success).toBe(true);
    expect(FeaturesUpdateRequest.safeParse({ ...update, walkthroughStep: 9 }).success).toBe(false);
    expect(
      FeatureConfiguration.safeParse({ ...input, values: { ...values, pdfOcr: "true" } }).success,
    ).toBe(false);
  });
});
