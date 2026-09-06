import { describe, expect, it } from "vitest";
import { decideSave, type SaveBaseline } from "./conflict";

const baseline: SaveBaseline = { modifiedAt: "2026-01-01T00:00:00.000Z", size: 100 };

describe("decideSave", () => {
  it("allows the save when nothing changed", () => {
    expect(decideSave(baseline, { ...baseline })).toBe("save");
  });

  it("flags a conflict when modifiedAt differs", () => {
    expect(decideSave(baseline, { ...baseline, modifiedAt: "2026-01-02T00:00:00.000Z" })).toBe(
      "conflict",
    );
  });

  it("flags a conflict when size differs", () => {
    expect(decideSave(baseline, { ...baseline, size: 101 })).toBe("conflict");
  });

  it("flags a conflict when both differ", () => {
    expect(decideSave(baseline, { modifiedAt: "2026-01-02T00:00:00.000Z", size: 200 })).toBe(
      "conflict",
    );
  });
});
