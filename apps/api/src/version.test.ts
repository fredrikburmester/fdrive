import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readBuild } from "./version";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
const revision = "0123456789abcdef0123456789abcdef01234567";

/** Serves these files next to package.json; every other file is missing. */
function imageFiles(files: Partial<Record<"build-revision" | "build-version", string>>) {
  vi.mocked(readFileSync).mockImplementation((path) => {
    const name = String(path).split("/").pop() as keyof typeof files;
    const content = files[name];
    if (content === undefined) throw new Error("ENOENT");
    return content;
  });
}

beforeEach(() => vi.resetAllMocks());

describe("running build", () => {
  it("reports the release and revision baked into an image", () => {
    imageFiles({ "build-revision": `${revision}\n`, "build-version": "0.1.0\n" });
    expect(readBuild()).toEqual({ revision, release: "0.1.0", version: revision });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ["main", "main"],
    ["1.2.3-rc.1", "1.2.3-rc.1"],
    ["v0.1.0", "0.1.0"],
  ])("reads the release %j as %j", (value, release) => {
    imageFiles({ "build-revision": revision, "build-version": value });
    expect(readBuild()).toMatchObject({ release });
  });

  it.each(["dev", "", "latest", "smoke", "1.2", "vmain"])(
    "treats the build version %j as no release",
    (value) => {
      imageFiles({ "build-revision": revision, "build-version": value });
      expect(readBuild()).toEqual({ revision, release: null, version: revision });
    },
  );

  it("treats an image from before build versions as no release", () => {
    imageFiles({ "build-revision": revision });
    expect(readBuild()).toEqual({ revision, release: null, version: revision });
  });

  it("reads the checkout revision once when no image metadata exists", () => {
    imageFiles({});
    vi.mocked(execFileSync).mockReturnValue(`${revision}\n`);
    expect(readBuild()).toEqual({ revision, release: null, version: revision });
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({ timeout: 1000 }),
    );
  });

  it("reports development when neither image metadata nor Git is available", () => {
    imageFiles({});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readBuild()).toEqual({ revision: null, release: null, version: "development" });
  });

  it.each(["", "not-a-revision"])(
    "does not report host Git when image metadata is %j",
    (metadata) => {
      imageFiles({ "build-revision": metadata, "build-version": "dev" });
      expect(readBuild()).toEqual({ revision: null, release: null, version: "development" });
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it("identifies an image built without a commit by its release", () => {
    imageFiles({ "build-revision": "", "build-version": "0.1.0" });
    expect(readBuild()).toEqual({ revision: null, release: "0.1.0", version: "0.1.0" });
  });
});
