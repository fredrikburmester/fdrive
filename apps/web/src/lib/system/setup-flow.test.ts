import { describe, expect, it } from "vitest";
import {
  canCompleteAccountStep,
  canLeaveConnectionStep,
  canLeaveTemplateStep,
  canLeaveTokenStep,
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
} from "./setup-flow";

describe("SETUP_STEPS", () => {
  it("is token, connection, template, account in order", () => {
    expect(SETUP_STEPS).toEqual(["token", "connection", "template", "account"]);
  });
});

describe("nextSetupStep", () => {
  it("advances through every step", () => {
    expect(nextSetupStep("token")).toBe("connection");
    expect(nextSetupStep("connection")).toBe("template");
    expect(nextSetupStep("template")).toBe("account");
  });

  it("returns null after the last step", () => {
    expect(nextSetupStep("account")).toBeNull();
  });
});

describe("previousSetupStep", () => {
  it("returns null before the first step", () => {
    expect(previousSetupStep("token")).toBeNull();
  });

  it("goes back through every step", () => {
    expect(previousSetupStep("connection")).toBe("token");
    expect(previousSetupStep("template")).toBe("connection");
    expect(previousSetupStep("account")).toBe("template");
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

describe("canLeaveConnectionStep", () => {
  it("is false without a test result", () => {
    expect(canLeaveConnectionStep("http://sftpgo:8080", null, null)).toBe(false);
  });

  it("is false when the test result failed", () => {
    expect(
      canLeaveConnectionStep(
        "http://sftpgo:8080",
        { ok: false, detail: "unreachable" },
        "http://sftpgo:8080",
      ),
    ).toBe(false);
  });

  it("is false when the base url is not http(s)", () => {
    expect(canLeaveConnectionStep("not-a-url", { ok: true, detail: "ok" }, "not-a-url")).toBe(
      false,
    );
  });

  it("is false when the tested url does not match the current one (stale pass)", () => {
    expect(
      canLeaveConnectionStep("http://sftpgo:8080", { ok: true, detail: "ok" }, "http://other:8080"),
    ).toBe(false);
  });

  it("is true with a passing, matching test result", () => {
    expect(
      canLeaveConnectionStep(
        "http://sftpgo:8080",
        { ok: true, detail: "ok" },
        "http://sftpgo:8080",
      ),
    ).toBe(true);
  });
});

describe("canLeaveTemplateStep", () => {
  it("is true for a plausible template", () => {
    expect(canLeaveTemplateStep("sftpgo:/{username}")).toBe(true);
  });

  it("is false for an implausible template", () => {
    expect(canLeaveTemplateStep("not-a-template")).toBe(false);
  });
});

describe("canCompleteAccountStep", () => {
  it("is false with a missing username or password", () => {
    expect(canCompleteAccountStep("", "hunter2")).toBe(false);
    expect(canCompleteAccountStep("alice", "")).toBe(false);
  });

  it("is true with both present", () => {
    expect(canCompleteAccountStep("alice", "hunter2")).toBe(true);
  });
});
