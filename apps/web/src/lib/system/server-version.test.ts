import { describe, expect, it } from "vitest";
import { describeServerVersion } from "./server-version";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("describeServerVersion", () => {
  it("shows a release with the commit it was built from", () => {
    expect(describeServerVersion({ version: revision, release: "0.1.0", revision })).toEqual({
      label: "0.1.0",
      revision,
    });
  });

  it("shows a build of main with its commit", () => {
    expect(describeServerVersion({ version: revision, release: "main", revision })).toEqual({
      label: "main",
      revision,
    });
  });

  it("labels a build that is not a release as development, with its commit", () => {
    expect(describeServerVersion({ version: revision, revision })).toEqual({
      label: "Development",
      revision,
    });
  });

  it("shows a release whose commit is unknown on its own", () => {
    expect(describeServerVersion({ version: "0.1.0", release: "0.1.0" })).toEqual({
      label: "0.1.0",
      revision: null,
    });
  });

  it("says when a development build knows no commit", () => {
    expect(describeServerVersion({ version: "development" })).toEqual({
      label: "Development (version unavailable)",
      revision: null,
    });
  });

  describe("an older server that sends only version", () => {
    it("shows its commit alone, since it may have been a release", () => {
      expect(describeServerVersion({ version: revision })).toEqual({ label: null, revision });
    });

    it("treats the 0.0.0 placeholder as development", () => {
      expect(describeServerVersion({ version: "0.0.0" })).toEqual({
        label: "Development (version unavailable)",
        revision: null,
      });
    });

    it("shows any other version as it was sent", () => {
      expect(describeServerVersion({ version: "1.2.3" })).toEqual({
        label: "1.2.3",
        revision: null,
      });
    });
  });
});
