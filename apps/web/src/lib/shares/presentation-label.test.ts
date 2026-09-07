import { describe, expect, it } from "vitest";
import {
  PRESENTATION_DESCRIPTION,
  PRESENTATION_LABEL,
  presentationLabel,
} from "./presentation-label";

describe("presentationLabel", () => {
  it("has a label and a one-line description for every presentation value", () => {
    for (const value of ["auto", "list", "gallery", "download"] as const) {
      expect(presentationLabel(value)).toBe(PRESENTATION_LABEL[value]);
      expect(PRESENTATION_DESCRIPTION[value].length).toBeGreaterThan(0);
    }
  });
});
