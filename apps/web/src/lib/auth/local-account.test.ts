import { describe, expect, it } from "vitest";
import {
  localPasswordError,
  localUsernameError,
  newPasswordErrors,
  passwordConfirmError,
} from "./local-account";

describe("localUsernameError", () => {
  it("asks for a username when the field is blank", () => {
    expect(localUsernameError("")).toBe("Enter a username.");
    expect(localUsernameError("   ")).toBe("Enter a username.");
  });

  it("accepts a name that can also be a folder name", () => {
    expect(localUsernameError("ada")).toBeNull();
    expect(localUsernameError("ada.lovelace@home")).toBeNull();
    expect(localUsernameError("  ada  ")).toBeNull();
  });

  it("refuses characters a folder name cannot carry, in the API's words", () => {
    expect(localUsernameError("ada/../root")).toBe(
      "Use letters, digits and . _ @ ~ - only, starting with a letter or digit.",
    );
    expect(localUsernameError(".hidden")).not.toBeNull();
  });
});

describe("localPasswordError", () => {
  it("asks for at least eight characters", () => {
    expect(localPasswordError("")).toBe("Use at least 8 characters.");
    expect(localPasswordError("short")).toBe("Use at least 8 characters.");
  });

  it("accepts eight characters or more, up to the API's limit", () => {
    expect(localPasswordError("12345678")).toBeNull();
    expect(localPasswordError("x".repeat(1025))).toBe("Use 1024 characters or fewer.");
  });
});

describe("passwordConfirmError", () => {
  it("is null when both match", () => {
    expect(passwordConfirmError("correct horse", "correct horse")).toBeNull();
  });

  it("says when they differ", () => {
    expect(passwordConfirmError("correct horse", "correct hors")).toBe(
      "The passwords don't match.",
    );
  });
});

describe("newPasswordErrors", () => {
  it("shows nothing for an untouched form, which is still not valid", () => {
    expect(newPasswordErrors({ password: "", confirm: "" })).toEqual({
      password: null,
      confirm: null,
      valid: false,
    });
  });

  it("shows each error once its field holds something", () => {
    expect(newPasswordErrors({ password: "short", confirm: "" })).toEqual({
      password: "Use at least 8 characters.",
      confirm: null,
      valid: false,
    });
    expect(newPasswordErrors({ password: "long enough", confirm: "long" })).toEqual({
      password: null,
      confirm: "The passwords don't match.",
      valid: false,
    });
  });

  it("is valid once the password passes and the repeat matches", () => {
    expect(newPasswordErrors({ password: "long enough", confirm: "long enough" })).toEqual({
      password: null,
      confirm: null,
      valid: true,
    });
  });
});
