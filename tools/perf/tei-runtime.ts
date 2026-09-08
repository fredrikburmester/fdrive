/** Runtime selection and recipe definition for text-embeddings-inference. */
import { arch } from "node:os";

export const TEI_MODEL_ID = "intfloat/multilingual-e5-small";
export const TEI_ARM64_IMAGE = "fdrive-tei-arm64:4150561d42c4";
export const TEI_ARM64_PLATFORM = "linux/arm64";
export const TEI_ARM64_REVISION = "4150561d42c495fe95f2aebb57fbb602c13ff4e6";
export const TEI_ARM64_CONTEXT_URL =
  "https://github.com/huggingface/text-embeddings-inference.git#4150561d42c495fe95f2aebb57fbb602c13ff4e6";
export const TEI_ARM64_DOCKERFILE = "Dockerfile-arm64";
export const TEI_ARM64_TARGET = "http";

export const TEI_X64_IMAGE = "ghcr.io/huggingface/text-embeddings-inference:cpu-latest";
export const TEI_X64_PLATFORM = "linux/amd64";

export interface TeiBuildRecipe {
  readonly context: string;
  readonly dockerfile: string;
  readonly target: string;
  readonly revision: string;
}

export interface TeiRuntimeConfig {
  readonly image: string;
  readonly platform: string;
  readonly model: string;
  readonly isNativeArm64: boolean;
  readonly source: string;
  readonly build?: TeiBuildRecipe;
}

export function selectTeiRuntime(targetArch: string = arch()): TeiRuntimeConfig {
  if (targetArch === "arm64") {
    return {
      image: TEI_ARM64_IMAGE,
      platform: TEI_ARM64_PLATFORM,
      model: TEI_MODEL_ID,
      isNativeArm64: true,
      source: TEI_ARM64_CONTEXT_URL,
      build: {
        context: TEI_ARM64_CONTEXT_URL,
        dockerfile: TEI_ARM64_DOCKERFILE,
        target: TEI_ARM64_TARGET,
        revision: TEI_ARM64_REVISION,
      },
    };
  }

  return {
    image: TEI_X64_IMAGE,
    platform: TEI_X64_PLATFORM,
    model: TEI_MODEL_ID,
    isNativeArm64: false,
    source: TEI_X64_IMAGE,
  };
}

export async function hasDockerImage(
  imageName: string,
  run: (program: string, args: string[]) => Promise<string>,
): Promise<boolean> {
  try {
    await run("docker", ["image", "inspect", imageName]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTeiImage(
  runtime: TeiRuntimeConfig,
  run: (program: string, args: string[]) => Promise<string>,
): Promise<void> {
  if (!runtime.build) {
    return;
  }

  const exists = await hasDockerImage(runtime.image, run);
  if (exists) {
    return;
  }

  await run("docker", [
    "build",
    "--platform",
    runtime.platform,
    "--target",
    runtime.build.target,
    "-t",
    runtime.image,
    "-f",
    runtime.build.dockerfile,
    runtime.build.context,
  ]);
}
