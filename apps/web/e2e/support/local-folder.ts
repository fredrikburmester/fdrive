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

/** alice's home on the shared run's Apache WebDAV server, signed in as `alice:alice-password`. */
export function webdavUrl(): string {
  return fromEnv("E2E_WEBDAV_URL");
}

/**
 * The same address spelled with the other loopback name, so a new row's
 * `(type, baseUrl)` pair does not collide with one already added while
 * still reaching the same server.
 */
export function otherLoopback(address: string): string {
  const url = new URL(address);
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  else throw new Error(`fdrive e2e: unexpected loopback host ${url.hostname}`);
  return url.href;
}
