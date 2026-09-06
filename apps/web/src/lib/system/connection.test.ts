import { describe, expect, it } from "vitest";
import {
  connectionSourceLabel,
  hasHomeTemplateChanged,
  homeTemplatePreview,
  isPlausibleHomeTemplate,
} from "./connection";

describe("connectionSourceLabel", () => {
  it("labels env as locked", () => {
    expect(connectionSourceLabel("env")).toBe("Environment (locked)");
  });

  it("labels settings as editable", () => {
    expect(connectionSourceLabel("settings")).toBe("Settings");
  });
});

describe("isPlausibleHomeTemplate", () => {
  it("accepts the default template", () => {
    expect(isPlausibleHomeTemplate("sftpgo:/{username}")).toBe(true);
  });

  it("accepts a template without the placeholder", () => {
    expect(isPlausibleHomeTemplate("sftpgo:/shared")).toBe(true);
  });

  it("rejects a missing colon", () => {
    expect(isPlausibleHomeTemplate("sftpgo/{username}")).toBe(false);
  });

  it("rejects an empty root name", () => {
    expect(isPlausibleHomeTemplate(":/{username}")).toBe(false);
  });

  it("rejects an uppercase root name", () => {
    expect(isPlausibleHomeTemplate("SFTPgo:/{username}")).toBe(false);
  });

  it("rejects a path that does not start with a slash", () => {
    expect(isPlausibleHomeTemplate("sftpgo:home/{username}")).toBe(false);
  });
});

describe("homeTemplatePreview", () => {
  it("substitutes the given username", () => {
    expect(homeTemplatePreview("sftpgo:/{username}", "carol")).toBe("carol → sftpgo:/carol");
  });

  it("falls back to a placeholder username when blank", () => {
    expect(homeTemplatePreview("sftpgo:/{username}", "  ")).toBe("alice → sftpgo:/alice");
  });

  it("trims surrounding whitespace from the username", () => {
    expect(homeTemplatePreview("sftpgo:/{username}", "  carol  ")).toBe("carol → sftpgo:/carol");
  });

  it("leaves a template with no placeholder unchanged", () => {
    expect(homeTemplatePreview("sftpgo:/shared", "carol")).toBe("carol → sftpgo:/shared");
  });
});

describe("hasHomeTemplateChanged", () => {
  it("is false for identical templates", () => {
    expect(hasHomeTemplateChanged("sftpgo:/{username}", "sftpgo:/{username}")).toBe(false);
  });

  it("is false when only surrounding whitespace differs", () => {
    expect(hasHomeTemplateChanged("sftpgo:/{username}", "  sftpgo:/{username}  ")).toBe(false);
  });

  it("is true when the templates differ", () => {
    expect(hasHomeTemplateChanged("sftpgo:/{username}", "sftpgo:/home/{username}")).toBe(true);
  });
});
