import { arch } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ensureTeiImage,
  hasDockerImage,
  selectTeiRuntime,
  TEI_ARM64_CONTEXT_URL,
  TEI_ARM64_DOCKERFILE,
  TEI_ARM64_IMAGE,
  TEI_ARM64_PLATFORM,
  TEI_ARM64_REVISION,
  TEI_ARM64_TARGET,
  TEI_MODEL_ID,
  TEI_X64_IMAGE,
  TEI_X64_PLATFORM,
} from "./tei-runtime.js";

describe("tei-runtime", () => {
  it("selects pinned native ARM64 runtime for arm64 architecture", () => {
    const runtime = selectTeiRuntime("arm64");
    expect(runtime.isNativeArm64).toBe(true);
    expect(runtime.image).toBe(TEI_ARM64_IMAGE);
    expect(runtime.platform).toBe(TEI_ARM64_PLATFORM);
    expect(runtime.model).toBe(TEI_MODEL_ID);
    expect(runtime.source).toBe(TEI_ARM64_CONTEXT_URL);
    expect(runtime.build).toEqual({
      context: TEI_ARM64_CONTEXT_URL,
      dockerfile: TEI_ARM64_DOCKERFILE,
      target: TEI_ARM64_TARGET,
      revision: TEI_ARM64_REVISION,
    });
  });

  it("selects AMD64 emulated runtime for x64 architecture", () => {
    const runtime = selectTeiRuntime("x64");
    expect(runtime.isNativeArm64).toBe(false);
    expect(runtime.image).toBe(TEI_X64_IMAGE);
    expect(runtime.platform).toBe(TEI_X64_PLATFORM);
    expect(runtime.model).toBe(TEI_MODEL_ID);
    expect(runtime.source).toBe(TEI_X64_IMAGE);
    expect(runtime.build).toBeUndefined();
  });

  it("selects AMD64 emulated runtime for other architectures", () => {
    const runtime = selectTeiRuntime("ia32");
    expect(runtime.isNativeArm64).toBe(false);
    expect(runtime.image).toBe(TEI_X64_IMAGE);
  });

  it("defaults to host architecture when no argument passed", () => {
    const runtime = selectTeiRuntime();
    if (arch() === "arm64") {
      expect(runtime.isNativeArm64).toBe(true);
      expect(runtime.image).toBe(TEI_ARM64_IMAGE);
    } else {
      expect(runtime.isNativeArm64).toBe(false);
      expect(runtime.image).toBe(TEI_X64_IMAGE);
    }
  });

  it("reports true when docker image exists", async () => {
    const calls: [string, string[]][] = [];
    const run = async (program: string, args: string[]): Promise<string> => {
      calls.push([program, args]);
      return "{}";
    };

    const exists = await hasDockerImage("some-image", run);
    expect(exists).toBe(true);
    expect(calls).toEqual([["docker", ["image", "inspect", "some-image"]]]);
  });

  it("reports false when docker image does not exist", async () => {
    const run = async (): Promise<string> => {
      throw Error("No such image");
    };

    const exists = await hasDockerImage("non-existent-image", run);
    expect(exists).toBe(false);
  });

  it("skips build when runtime has no build recipe", async () => {
    const calls: [string, string[]][] = [];
    const run = async (program: string, args: string[]): Promise<string> => {
      calls.push([program, args]);
      return "";
    };

    const x64Runtime = selectTeiRuntime("x64");
    await ensureTeiImage(x64Runtime, run);
    expect(calls).toEqual([]);
  });

  it("skips build when image already exists in docker cache", async () => {
    const calls: [string, string[]][] = [];
    const run = async (program: string, args: string[]): Promise<string> => {
      calls.push([program, args]);
      return "{}";
    };

    const arm64Runtime = selectTeiRuntime("arm64");
    await ensureTeiImage(arm64Runtime, run);
    expect(calls).toEqual([["docker", ["image", "inspect", arm64Runtime.image]]]);
  });

  it("builds image when native image is missing from docker cache", async () => {
    const calls: [string, string[]][] = [];
    const run = async (program: string, args: string[]): Promise<string> => {
      calls.push([program, args]);
      if (args[0] === "image" && args[1] === "inspect") {
        throw Error("image not found");
      }
      return "built";
    };

    const arm64Runtime = selectTeiRuntime("arm64");
    await ensureTeiImage(arm64Runtime, run);
    expect(calls).toEqual([
      ["docker", ["image", "inspect", arm64Runtime.image]],
      [
        "docker",
        [
          "build",
          "--platform",
          TEI_ARM64_PLATFORM,
          "--target",
          TEI_ARM64_TARGET,
          "-t",
          TEI_ARM64_IMAGE,
          "-f",
          TEI_ARM64_DOCKERFILE,
          TEI_ARM64_CONTEXT_URL,
        ],
      ],
    ]);
  });

  it("propagates failure when native docker build fails without fallback", async () => {
    const run = async (_program: string, args: string[]): Promise<string> => {
      if (args[0] === "image" && args[1] === "inspect") {
        throw Error("image not found");
      }
      throw Error("docker build failed");
    };

    const arm64Runtime = selectTeiRuntime("arm64");
    await expect(ensureTeiImage(arm64Runtime, run)).rejects.toThrow("docker build failed");
  });
});
