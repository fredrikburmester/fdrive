import { describe, expect, it } from "vitest";
import { describeServerVersion } from "./server-version";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("describeServerVersion", () => {
  it("shows a release with the commit it was built from", () => {
    expect(describeServerVersion({ release: "0.1.0", revision })).toEqual({
      label: "0.1.0",
      revision,
    });
  });

  it("shows a build of main with its commit", () => {
    expect(describeServerVersion({ release: "main", revision })).toEqual({
      label: "main",
      revision,
    });
  });

  it("labels a build that is not a release as development, with its commit", () => {
    expect(describeServerVersion({ revision })).toEqual({ label: "Development", revision });
  });

  it("shows a release whose commit is unknown on its own", () => {
    expect(describeServerVersion({ release: "0.1.0" })).toEqual({
      label: "0.1.0",
      revision: null,
    });
  });

  it("says when a development build knows no commit", () => {
    expect(describeServerVersion({})).toEqual({
      label: "Development (version unavailable)",
      revision: null,
    });
  });
});
