import type { ProviderField } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  canLeaveConnectionStep,
  canLeaveTokenStep,
  connectionStepError,
  connectionTestKey,
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
  type SetupConnectionDraft,
} from "./setup-flow";

const DRAFT: SetupConnectionDraft = {
  type: "s3",
  label: "Media",
  baseUrl: "https://s3.example.com/media",
  config: { region: " eu-west-1 " },
};

const REGION: ProviderField = { name: "region", label: "Region", kind: "text", required: true };

describe("SETUP_STEPS", () => {
  it("asks a local folder only for the token and the owner's account", () => {
    expect(SETUP_STEPS.local).toEqual(["token", "account"]);
  });

  it("connects storage between the token and the account without a local folder", () => {
    expect(SETUP_STEPS.provider).toEqual(["token", "connection", "account"]);
  });
});

describe("nextSetupStep", () => {
  it("goes straight from the token to the account for a local folder", () => {
    expect(nextSetupStep("local", "token")).toBe("account");
    expect(nextSetupStep("local", "account")).toBeNull();
  });

  it("advances through every provider step", () => {
    expect(nextSetupStep("provider", "token")).toBe("connection");
    expect(nextSetupStep("provider", "connection")).toBe("account");
    expect(nextSetupStep("provider", "account")).toBeNull();
  });
});

describe("previousSetupStep", () => {
  it("returns null before the first step", () => {
    expect(previousSetupStep("local", "token")).toBeNull();
    expect(previousSetupStep("provider", "token")).toBeNull();
  });

  it("goes back through the mode's own steps", () => {
    expect(previousSetupStep("local", "account")).toBe("token");
    expect(previousSetupStep("provider", "account")).toBe("connection");
    expect(previousSetupStep("provider", "connection")).toBe("token");
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

describe("connectionTestKey", () => {
  it("ignores the name, surrounding spaces and blank optional fields", () => {
    expect(
      connectionTestKey({
        ...DRAFT,
        label: "Renamed",
        baseUrl: ` ${DRAFT.baseUrl} `,
        config: { region: "eu-west-1", prefix: "" },
      }),
    ).toBe(connectionTestKey(DRAFT));
  });

  it("changes with the type, the address or the configuration", () => {
    const key = connectionTestKey(DRAFT);
    expect(connectionTestKey({ ...DRAFT, type: "webdav" })).not.toBe(key);
    expect(connectionTestKey({ ...DRAFT, baseUrl: "https://other.example.com/" })).not.toBe(key);
    expect(connectionTestKey({ ...DRAFT, config: { region: "us-east-1" } })).not.toBe(key);
  });
});

describe("connectionStepError", () => {
  it("asks for a type first", () => {
    expect(connectionStepError([], { ...DRAFT, type: "" })).toBe("Choose a storage type.");
  });

  it("names the first missing piece of the form", () => {
    expect(connectionStepError([], { ...DRAFT, label: " " })).toBe(
      "Enter a name for this storage.",
    );
    expect(connectionStepError([], { ...DRAFT, baseUrl: "s3.example.com" })).toBe(
      "Enter the address as an http(s) URL.",
    );
    expect(connectionStepError([REGION], { ...DRAFT, config: {} })).toBe("Enter region.");
  });

  it("is null for a complete form", () => {
    expect(connectionStepError([REGION], DRAFT)).toBeNull();
  });
});

describe("canLeaveConnectionStep", () => {
  const passed = { ok: true, detail: "ok" };

  it("is false without a test result", () => {
    expect(canLeaveConnectionStep([REGION], DRAFT, null, null)).toBe(false);
  });

  it("is false when the test failed", () => {
    expect(
      canLeaveConnectionStep(
        [REGION],
        DRAFT,
        { ok: false, detail: "unreachable" },
        connectionTestKey(DRAFT),
      ),
    ).toBe(false);
  });

  it("is false when the form is incomplete, even after a pass", () => {
    const draft = { ...DRAFT, label: "" };
    expect(canLeaveConnectionStep([REGION], draft, passed, connectionTestKey(draft))).toBe(false);
  });

  it("is false when the pass belongs to an address edited since (stale pass)", () => {
    const tested = connectionTestKey({ ...DRAFT, baseUrl: "https://old.example.com/media" });
    expect(canLeaveConnectionStep([REGION], DRAFT, passed, tested)).toBe(false);
  });

  it("is true with a passing test of exactly what is typed", () => {
    expect(canLeaveConnectionStep([REGION], DRAFT, passed, connectionTestKey(DRAFT))).toBe(true);
  });
});
