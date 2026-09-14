import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectRetentionCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  digest,
  discoverBackups,
  fetchBackup,
  fileStream,
  probeDestination,
  s3Destination,
  verifyDelivery,
} from "../../src/index.js";

let container: Awaited<ReturnType<GenericContainer["start"]>>;
let directory: string;
let admin: S3Client;
let destination: ReturnType<typeof s3Destination>;
const bucket = "fdrive-backup-protocol-test";
const prefix = `private/${randomUUID()}`;
beforeAll(async () => {
  container = await new GenericContainer("quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z")
    .withEnvironment({
      MINIO_ROOT_USER: "test-backup-user",
      MINIO_ROOT_PASSWORD: "test-backup-password",
    })
    .withCommand(["server", "/data"])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .start();
  directory = await mkdtemp(join(tmpdir(), "fdrive-s3-"));
  const config = {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    region: "us-east-1",
    bucket,
    prefix,
    pathStyle: true,
    accessKeyId: "test-backup-user",
    secretAccessKey: "test-backup-password",
  };
  admin = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  await admin.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  await admin.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  destination = s3Destination(config);
});
afterAll(async () => {
  admin?.destroy();
  await container?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("streams multipart ciphertext, verifies exact versions, discovers and fetches completion records, and respects Object Lock", async () => {
  await probeDestination(destination);
  expect(await destination.list()).toEqual([]);
  const encrypt = new Encrypter();
  encrypt.addRecipient(await identityToRecipient(await generateIdentity()));
  const file = join(directory, "archive.age");
  await writeFile(file, await encrypt.encrypt(randomBytes(20 * 1024 * 1024)));
  const id = randomUUID();
  const key = `${id}.fdrive.age`;
  const result = await verifyDelivery(destination, key, file);
  expect(result.versionId).toBeTruthy();
  expect((await verifyDelivery(destination, key, file)).versionId).toBe(result.versionId);
  expect((await destination.information(key))?.versioning).toBe("Enabled");
  const versions = await admin.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${prefix}/${key}` }),
  );
  expect(versions.Versions).toHaveLength(1);
  const bytes = await digest(fileStream(file));
  const completion = join(directory, "complete.json");
  await writeFile(
    completion,
    JSON.stringify({
      format: 1,
      installationId: randomUUID(),
      id,
      createdAt: new Date().toISOString(),
      key,
      bytes: String(bytes.bytes),
      sha256: bytes.sha256,
      versionId: result.versionId,
      coverage: [],
    }),
  );
  const marker = await verifyDelivery(destination, `${id}.complete.json`, completion);
  expect((await discoverBackups(destination))[0]?.id).toBe(id);
  const fetched = join(directory, "downloaded.age");
  await fetchBackup(destination, id, fetched);
  expect(await digest(fileStream(fetched))).toEqual(bytes);
  await admin.send(
    new PutObjectRetentionCommand({
      Bucket: bucket,
      Key: `${prefix}/${key}`,
      VersionId: result.versionId,
      Retention: { Mode: "GOVERNANCE", RetainUntilDate: new Date(Date.now() + 60_000) },
    }),
  );
  expect((await destination.information(key))?.retentionUntil).toBeTruthy();
  await expect(destination.remove(key, result.versionId)).rejects.toThrow();
  await destination.remove(`${id}.complete.json`, marker.versionId);
  expect(await discoverBackups(destination)).toEqual([]);
  expect(await destination.information(key)).not.toBeNull();
});
