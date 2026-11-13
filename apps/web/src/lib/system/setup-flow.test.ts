import { describe, expect, it } from "vitest";
import { canLeaveTokenStep, nextSetupStep, previousSetupStep, SETUP_STEPS } from "./setup-flow";

describe("SETUP_STEPS", () => {
  it("asks only for the token and the owner's account", () => {
    expect(SETUP_STEPS).toEqual(["token", "account"]);
  });
});

describe("nextSetupStep", () => {
  it("goes straight from the token to the account", () => {
    expect(nextSetupStep("token")).toBe("account");
    expect(nextSetupStep("account")).toBeNull();
  });
});

describe("previousSetupStep", () => {
  it("returns null before the first step", () => {
    expect(previousSetupStep("token")).toBeNull();
  });

  it("goes back from the account to the token", () => {
    expect(previousSetupStep("account")).toBe("token");
  });
});

describe("canLeaveTokenStep", () => {
  it("is false for an empty token", () => {
    expect(canLeaveTokenStep("")).toBe(false);
    expect(canLeaveTokenStep("   ")).toBe(false);
  });

  it("is true for a non-empty token", () => {
    expect(canLeaveTokenStep("abc123")).toBe(true);
  });
});
