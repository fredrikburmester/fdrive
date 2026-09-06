import { describe, expect, it } from "vitest";
import { durationSeconds } from "./scenarios.js";

describe("durationSeconds", () => {
  it("returns normalSeconds when no quickSeconds is given", () => {
    expect(durationSeconds(30, {})).toBe(30);
  });

  it("returns quickSeconds when given and no floor applies", () => {
    expect(durationSeconds(30, { quickSeconds: 5 })).toBe(5);
  });

  it("clamps quickSeconds up to the floor when it would be lower", () => {
    expect(durationSeconds(30, { quickSeconds: 5 }, 20)).toBe(20);
  });

  it("does not clamp normalSeconds down to the floor when it is already higher", () => {
    expect(durationSeconds(30, {}, 20)).toBe(30);
  });

  it("does not clamp quickSeconds when it already exceeds the floor", () => {
    expect(durationSeconds(30, { quickSeconds: 25 }, 20)).toBe(25);
  });

  it("defaults the floor to 0", () => {
    expect(durationSeconds(30, { quickSeconds: 0 })).toBe(0);
  });
});
