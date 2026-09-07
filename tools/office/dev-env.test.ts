import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDevEnvironment, devEnvironment, officeProduct } from "./dev-env.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
it("accepts explicit products and rejects missing or unsupported products", () => {
  expect(officeProduct("onlyoffice")).toBe("onlyoffice");
  expect(officeProduct("collabora")).toBe("collabora");
  expect(() => officeProduct(undefined)).toThrow("Usage:");
  expect(() => officeProduct("word")).toThrow("Usage:");
});
it("renders bounded dev origins with an injection-safe secret", () => {
  const secret = "a".repeat(64);
  expect(devEnvironment("onlyoffice", secret)).toContain(
    "FDRIVE_OFFICE_URL=http://localhost:58090\n",
  );
  expect(devEnvironment("collabora", secret)).toContain(
    "FDRIVE_OFFICE_PUBLIC_URL=http://localhost:58091\n",
  );
  expect(devEnvironment("onlyoffice", secret)).toContain(
    "FDRIVE_WOPI_URL=http://host.docker.internal:3001/wopi\n",
  );
  expect(() => devEnvironment("onlyoffice", "a\nINJECT=true")).toThrow("32-byte");
});
it("creates a private environment once without overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fdrive-office-env-"));
  directories.push(directory);
  const path = join(directory, ".env.office.dev");
  expect(await createDevEnvironment(path, "onlyoffice")).toBe(true);
  const first = await readFile(path, "utf8");
  expect(first).toMatch(/ONLYOFFICE_JWT_SECRET=[a-f0-9]{64}\n/);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await createDevEnvironment(path, "onlyoffice")).toBe(false);
  expect(await readFile(path, "utf8")).toBe(first);
  await expect(
    createDevEnvironment(join(directory, "missing", "file"), "collabora"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(directory, "already-directory"));
  expect(await createDevEnvironment(join(directory, "already-directory"), "collabora")).toBe(false);
});
