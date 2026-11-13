import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStorageProvider } from "@fdrive/testkit";
import { createLocalStorage } from "./storage-provider.js";

describeStorageProvider("local", async () => {
  const root = await mkdtemp(join(tmpdir(), "fdrive-local-"));
  return {
    storage: createLocalStorage({ home: join(root, "alice") }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});
