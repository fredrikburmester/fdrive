import { expect, it, vi } from "vitest";
import { createBackupClient } from "./backup-client.js";
import { BackupDestinationInput, BackupSchedule, BackupsResponse } from "./backups.js";

const id = "f9c0b4ba-7b67-4e2f-abf3-08d1a0e6d652";
it("sends the owner session and CSRF marker for every backup operation", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const url = String(input);
    return Response.json(
      url.endsWith("/key")
        ? { challenge: "ciphertext" }
        : url.endsWith("/estimate") ||
            url.endsWith("/runs") ||
            /\/destinations(\/[^/]+)?$/.test(url)
          ? { id, ok: true }
          : { ok: true },
    );
  });
  const client = createBackupClient({
    fetch,
    baseUrl: "https://fdrive.invalid",
  });
  await client.unlock("owner-password");
  await client.key("public key");
  await client.confirm("proof");
  await client.estimate();
  await client.recordRehearsal({
    sourceInstallationId: id,
    snapshotId: id,
    completedAt: new Date().toISOString(),
    migrations: [],
    tableCount: 29,
    blobCount: 1,
    result: "passed",
  });
  await client.schedule({
    frequency: "manual",
    timezone: "UTC",
    hour: 3,
    daily: 7,
    weekly: 4,
    monthly: 12,
  });
  await client.create({ destinationIds: [id], metadataOnly: false });
  await client.verify(id);
  await client.cancel(id);
  await client.retry(id);
  await client.pin(id, true);
  await client.remove(id);
  await client.destinationSchedule(id, null);
  const destination = {
    type: "s3" as const,
    name: "Backup",
    endpoint: "https://s3.invalid",
    region: "region",
    bucket: "private",
    prefix: "fdrive",
    pathStyle: false,
    accessKeyId: "key",
    secretAccessKey: "secret",
  };
  await client.destination(destination);
  await client.destination(destination, id);
  await client.testDestination(id);
  await client.removeDestination(id);
  for (const [_url, init] of fetch.mock.calls) {
    expect(init?.credentials).toBe("same-origin");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-requested-with")).toBe("fdrive");
  }
  const unlock = fetch.mock.calls.find(([url]) => String(url).endsWith("/unlock"));
  expect(JSON.parse(String(unlock?.[1]?.body))).toEqual({ password: "owner-password" });
  expect(client.downloadUrl("path/escape")).toContain("path%2Fescape/download");
});
it("validates server responses and reports structured and malformed errors", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createBackupClient({ fetch });
  fetch.mockResolvedValueOnce(
    Response.json(
      { error: { kind: "reauth_required", message: "Confirm password" } },
      { status: 401 },
    ),
  );
  await expect(client.status()).rejects.toMatchObject({
    kind: "reauth_required",
    message: "Confirm password",
  });
  fetch.mockResolvedValueOnce(new Response("not JSON", { status: 502 }));
  await expect(client.status()).rejects.toMatchObject({
    kind: "internal",
    message: "Backup request failed",
  });
  fetch.mockResolvedValueOnce(Response.json({}));
  await expect(client.status()).rejects.toThrow();
  const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
  try {
    await createBackupClient().confirm("proof");
    expect(globalFetch).toHaveBeenCalled();
  } finally {
    globalFetch.mockRestore();
  }
});
it("rejects unsafe destinations and invalid schedules before making requests", () => {
  expect(BackupSchedule.safeParse({ timezone: "not/a/zone" }).success).toBe(false);
  expect(BackupSchedule.parse({ timezone: "UTC" }).frequency).toBe("manual");
  const value = {
    type: "s3",
    name: "Backup",
    endpoint: "https://bucket.invalid",
    region: "test",
    bucket: "backup",
    prefix: "data",
    accessKeyId: "key",
    secretAccessKey: "secret",
  };
  for (const endpoint of [
    "ftp://bucket.invalid",
    "https://user:secret@bucket.invalid",
    "https://bucket.invalid?secret=x",
    "https://bucket.invalid#fragment",
  ])
    expect(BackupDestinationInput.safeParse({ ...value, endpoint }).success).toBe(false);
  for (const prefix of ["../escape", "a/./b", "a\\b", "a\0b"])
    expect(BackupDestinationInput.safeParse({ ...value, prefix }).success).toBe(false);
  expect(
    BackupDestinationInput.safeParse({
      ...value,
      endpoint: "http://local.invalid:9000",
      prefix: "private/fdrive",
    }).success,
  ).toBe(true);
});
it("accepts only S3 destinations: a folder in the files folder is not a destination", () => {
  const files = { type: "provider", name: "Files", providerId: id, prefix: "/Backups" };
  expect(BackupDestinationInput.safeParse(files).success).toBe(false);
  expect(BackupDestinationInput.safeParse({ ...files, type: "s3" }).success).toBe(false);
});
it("has no configuration ZIP attachments", () => {
  const client = createBackupClient({ fetch: vi.fn<typeof globalThis.fetch>() });
  for (const name of ["upload", "removeAttachment", "attachmentUrl"])
    expect(client).not.toHaveProperty(name);
  const status = BackupsResponse.parse({
    enabled: true,
    owner: true,
    installationId: id,
    recipient: null,
    keyConfirmed: false,
    schedule: { timezone: "UTC" },
    nextRunAt: null,
    restored: false,
    destinations: [],
    attachments: [{ id }],
    runs: [],
  });
  expect(status).not.toHaveProperty("attachments");
});
