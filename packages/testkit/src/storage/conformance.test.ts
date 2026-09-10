import type { StorageProvider } from "@fdrive/core";
import { describeStorageProvider } from "./conformance.ts";
import { createMemoryStorage } from "./memory-storage.ts";

describeStorageProvider("memory storage", () => ({ storage: createMemoryStorage() }));

describeStorageProvider(
  "memory storage with a fixed workspace",
  () => ({ storage: createMemoryStorage(), cleanup: async () => {} }),
  { workspace: "/work", probe: false },
);

/** Memory storage dressed as a backend that overwrites on move, zips, and has no mtime or probe. */
function overwritingZippingStorage(): StorageProvider {
  const base = createMemoryStorage();
  const { setModifiedAt: _mtime, probeDirectoryRead: _probe, ...rest } = base;
  return {
    ...rest,
    move: (path, target, opts) => base.move(path, target, { overwrite: opts?.overwrite ?? true }),
    zip: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]));
          controller.close();
        },
      }),
  };
}

describeStorageProvider(
  "overwriting, zipping storage without mtime or probe",
  () => ({ storage: overwritingZippingStorage() }),
  { overwritesOnMove: true },
);
