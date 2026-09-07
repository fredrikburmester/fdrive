import { chmod, chown, copyFile } from "node:fs/promises";
import { initializeProofKeys } from "./keys.ts";

await initializeProofKeys("/keys", { uid: 1001, gid: 1001 });
// The pinned distroless server reads proof_key beside its main configuration.
await copyFile("/template/coolwsd.xml", "/keys/coolwsd.xml");
await chmod("/keys/coolwsd.xml", 0o600);
await chown("/keys/coolwsd.xml", 1001, 1001);
console.info("Collabora proof keys ready; existing keys preserved.");
