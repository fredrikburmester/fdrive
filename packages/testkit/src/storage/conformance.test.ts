import { describeStorageProvider } from "./conformance.ts";
import { createMemoryStorage } from "./memory-storage.ts";

describeStorageProvider("memory storage", () => ({ storage: createMemoryStorage() }));
