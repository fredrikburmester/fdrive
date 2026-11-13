import { join } from "node:path";

function fromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`fdrive e2e: ${name} is not set; global-setup exports it`);
  }
  return value;
}

/**
 * Where `virtualPath` in `username`'s files is on the host's disk, in the
 * shared run's local folder (`FDRIVE_STORAGE_ROOT`). Specs change files
 * here directly to act as a writer outside fdrive: the host, rsync, OCR.
 */
export function homePath(username: string, virtualPath = "/"): string {
  return join(fromEnv("E2E_STORAGE_ROOT"), username, virtualPath);
}
