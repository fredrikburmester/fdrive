import type { StorageProvider } from "@fdrive/core";
import { describeStorageProvider } from "./conformance.ts";
import { createMemoryStorage } from "./memory-storage.ts";

describeStorageProvider("memory storage", () => ({ storage: createMemoryStorage() }));

describeStorageProvider(
  "memory storage with a fixed workspace",
  () => ({ storage: createMemoryStorage(), cleanup: async () => {} }),
  { workspace: "/work", probe: false },
);

/**
 * Memory storage dressed as a backend that zips, proves a file readable
 * without downloading it, and has no mtime or directory probe.
 */
function zippingStorage(): StorageProvider {
  const base = createMemoryStorage();
  const { setModifiedAt: _mtime, probeDirectoryRead: _probe, ...rest } = base;
  return {
    ...rest,
    probeFileRead: async (path) => {
      await base.statFile(path);
    },
    zip: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]));
          controller.close();
        },
      }),
  };
}

describeStorageProvider("zipping storage without mtime or directory probe", () => ({
  storage: zippingStorage(),
}));
