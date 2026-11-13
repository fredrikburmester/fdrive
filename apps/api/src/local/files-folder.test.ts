import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FILES_FOLDER_REASONS, FILES_MARKER } from "@fdrive/local";
import { describe, expect, it, vi } from "vitest";
import { createDeploymentFilesFolderGuard, filesFolderHealth } from "./files-folder.js";
import { temporaryStorageRoot } from "./test-fixtures/index.ts";

const ID = "3e5d2b8a-7c41-4f0e-a9d6-1b2c3d4e5f60";

function facts(holds: boolean) {
  return { installationId: async () => ID, holdsFiles: async () => holds };
}

function log() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("createDeploymentFilesFolderGuard", () => {
  it("logs an adoption once, then a verified folder, and reports it healthy", async () => {
    const root = temporaryStorageRoot();
    mkdirSync(join(root, "alice"));
    const lines = log();
    await createDeploymentFilesFolderGuard(root, facts(true), lines).verify();
    expect(readFileSync(join(root, FILES_MARKER), "utf8")).toBe(`${ID}\n`);
    expect(lines.info).toHaveBeenCalledExactlyOnceWith(
      `files folder ${root} adopted: wrote ${FILES_MARKER} with this installation's id`,
    );

    // The next start finds its own marker.
    const restarted = createDeploymentFilesFolderGuard(root, facts(true), lines);
    await expect(filesFolderHealth(restarted)).resolves.toBe(true);
    expect(lines.info).toHaveBeenLastCalledWith(`files folder ${root} verified`);
    expect(lines.error).not.toHaveBeenCalled();
  });

  it("logs a refusal loudly and fails health with the reason", async () => {
    const root = temporaryStorageRoot();
    const lines = log();
    const guard = createDeploymentFilesFolderGuard(root, facts(true), lines);
    await expect(filesFolderHealth(guard)).resolves.toEqual({
      failed: FILES_FOLDER_REASONS.empty,
    });
    expect(lines.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`files folder ${root} refused: ${FILES_FOLDER_REASONS.empty}`),
    );
    expect(guard.refusal()).toBe(FILES_FOLDER_REASONS.empty);
    expect(lines.info).not.toHaveBeenCalled();
  });
});
