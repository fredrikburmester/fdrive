import { expect, it } from "vitest";
import { fixtureCompose, parsePort, parseProduct } from "./fixture-config";
import { storedPath } from "./storage";

it("uses supported products only", () => {
  expect(parseProduct(undefined)).toBe("onlyoffice");
  expect(parseProduct("onlyoffice")).toBe("onlyoffice");
  expect(parseProduct("collabora")).toBe("collabora");
  expect(() => parseProduct("unknown")).toThrow();
});
it("keeps fixture ports distinct from development", () => {
  expect(parsePort(undefined, 39421)).toBe(39421);
  expect(parsePort("59490", 1)).toBe(59490);
  for (const value of ["", "1", "-1", "1.5", "65536", "abc", "3001", "3002", "58090", "58091"])
    expect(() => parsePort(value, 39421)).toThrow();
});
it("extends pinned deployment with isolated port and callback settings", () => {
  const onlyoffice = fixtureCompose(
    "/fixture/deploy/office/compose.services.yaml",
    "onlyoffice",
    59490,
    39421,
    39422,
    "fixture-worker-token",
  );
  expect(onlyoffice.services.onlyoffice).toMatchObject({
    build: { context: "/fixture", dockerfile: "deploy/office/Dockerfile.onlyoffice" },
    environment: {
      FDRIVE_WORKER_TOKEN: "fixture-worker-token",
      FDRIVE_OFFICE_SETTINGS_URL: "http://host.docker.internal:39421/api/v1/internal/office",
    },
    restart: "no",
    ports: ["127.0.0.1:59490:80"],
  });
  expect(onlyoffice.services.collabora).toBeUndefined();
  const collabora = fixtureCompose(
    "/fixture/deploy/office/compose.services.yaml",
    "collabora",
    59491,
    39421,
    39422,
    "fixture-worker-token",
  );
  expect(collabora.services.collabora?.command).toContain(
    "--o:storage.wopi.alias_groups.group[0].host=http://host.docker.internal:39421",
  );
  expect(collabora.services.collabora?.command).toContain(
    "--o:net.content_security_policy=frame-ancestors http://127.0.0.1:39422;",
  );
  expect(collabora.services["collabora-keys"]).toMatchObject({
    extends: { service: "collabora-keys" },
  });
});
it("confines fixture paths to alice's home in the local folder", () => {
  const state = { storageRoot: "/tmp/fixture-root" };
  expect(storedPath(state, "/Å %20.docx")).toBe("/tmp/fixture-root/alice/Å %20.docx");
  expect(storedPath(state, "/nested/a b.xlsx")).toBe("/tmp/fixture-root/alice/nested/a b.xlsx");
  for (const value of [
    "",
    "relative.docx",
    "/",
    "/a//b",
    "/../bob/x",
    "/a/./b",
    "/a\\b",
    "/a\nb",
    "/a\rb",
    "/a\0b",
  ])
    expect(() => storedPath(state, value)).toThrow("Invalid fixture path");
});
