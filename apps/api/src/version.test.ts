import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVersion } from "./version";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
const revision = "0123456789abcdef0123456789abcdef01234567";

beforeEach(() => vi.resetAllMocks());

describe("running version", () => {
  it("prefers the revision baked into the image over the host checkout", () => {
    vi.mocked(readFileSync).mockReturnValue(`${revision}\n`);
    expect(readVersion()).toBe(revision);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("reads the checkout revision once when no image metadata exists", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(execFileSync).mockReturnValue(`${revision}\n`);
    expect(readVersion()).toBe(revision);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({ timeout: 1000 }),
    );
  });

  it("falls back to a package release when Git is unavailable", () => {
    vi.mocked(readFileSync)
      .mockImplementationOnce(() => {
        throw new Error("ENOENT");
      })
      .mockReturnValue('{"version":"1.2.3"}');
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readVersion()).toBe("1.2.3");
  });

  it.each(["", "not-a-revision"])(
    "does not report host Git when image metadata is %j",
    (metadata) => {
      vi.mocked(readFileSync).mockReturnValueOnce(metadata).mockReturnValue('{"version":"0.0.0"}');
      expect(readVersion()).toBe("development");
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it("handles a missing package version", () => {
    vi.mocked(readFileSync).mockReturnValueOnce("").mockReturnValue("{}");
    expect(readVersion()).toBe("development");
  });
});
