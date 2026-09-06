import { parseHomeTemplate } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { dateFromMtimeNs, toIndexRelativePath, usableScopesFor } from "./scopes";

const HOME_TEMPLATE = parseHomeTemplate("sftpgo:/{username}");

describe("usableScopesFor", () => {
  it("returns the home scope when its root is configured", () => {
    const scopes = usableScopesFor(HOME_TEMPLATE, new Set(["sftpgo"]), "alice");
    expect(scopes).toEqual([{ rootName: "sftpgo", fsPrefix: "/alice", virtualPrefix: "/" }]);
  });

  it("returns an empty array when the home root is not configured", () => {
    expect(usableScopesFor(HOME_TEMPLATE, new Set(["other"]), "alice")).toEqual([]);
  });

  it("returns an empty array when the username is not a safe path segment", () => {
    expect(usableScopesFor(HOME_TEMPLATE, new Set(["sftpgo"]), "a/b")).toEqual([]);
  });

  it("returns an empty array when no index roots are configured", () => {
    expect(usableScopesFor(HOME_TEMPLATE, new Set(), "alice")).toEqual([]);
  });
});

describe("dateFromMtimeNs", () => {
  it("converts nanoseconds since epoch to a Date at millisecond precision", () => {
    const ns = 1_700_000_000_000_000_000n;
    expect(dateFromMtimeNs(ns)).toEqual(new Date(1_700_000_000_000));
  });

  it("converts zero to the epoch", () => {
    expect(dateFromMtimeNs(0n)).toEqual(new Date(0));
  });
});

describe("toIndexRelativePath", () => {
  it("maps the root prefix to an empty string", () => {
    expect(toIndexRelativePath("/")).toBe("");
  });

  it("strips the leading slash from a subtree path", () => {
    expect(toIndexRelativePath("/alice/photos")).toBe("alice/photos");
  });
});
