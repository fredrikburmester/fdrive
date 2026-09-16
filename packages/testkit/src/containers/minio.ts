import { GenericContainer, Wait } from "testcontainers";

/** The image the backup suite already pins; one MinIO build across the repository. */
const DEFAULT_IMAGE = "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z";
const API_PORT = 9000;
const ROOT = { accessKeyId: "fdrive-root", secretAccessKey: "fdrive-root-password" };

export interface MinioKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface StartMinioOptions {
  readonly image?: string;
  /** The bucket created at start. Default `fdrive`. */
  readonly bucket?: string;
}

export interface MinioContainer {
  /** Origin only, `http://host:port`. */
  readonly endpoint: string;
  readonly bucket: string;
  /** The provider row address: the endpoint with the bucket in its path. */
  readonly baseUrl: string;
  /** Root credentials, for fixtures that need to administer the server. */
  readonly root: MinioKey;
  /** A user with the built-in `readwrite` policy. */
  readonly writer: MinioKey;
  /** A user with the built-in `readonly` policy: every write answers `AccessDenied`. */
  readonly reader: MinioKey;
  stop(): Promise<void>;
}

/**
 * Disposable MinIO server with one bucket and two users, created through
 * the `mc` client the image ships. The real S3 target the S3 provider is
 * verified against; the browser suite adds it as a provider row too.
 */
export async function startMinio(options: StartMinioOptions = {}): Promise<MinioContainer> {
  const bucket = options.bucket ?? "fdrive";
  const writer = { accessKeyId: "fdrive-writer", secretAccessKey: "fdrive-writer-password" };
  const reader = { accessKeyId: "fdrive-reader", secretAccessKey: "fdrive-reader-password" };
  const container = await new GenericContainer(options.image ?? DEFAULT_IMAGE)
    .withEnvironment({
      MINIO_ROOT_USER: ROOT.accessKeyId,
      MINIO_ROOT_PASSWORD: ROOT.secretAccessKey,
    })
    .withCommand(["server", "/data"])
    .withExposedPorts(API_PORT)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", API_PORT))
    .start();
  const commands = [
    [
      "alias",
      "set",
      "local",
      `http://127.0.0.1:${API_PORT}`,
      ROOT.accessKeyId,
      ROOT.secretAccessKey,
    ],
    ["mb", `local/${bucket}`],
    ["admin", "user", "add", "local", writer.accessKeyId, writer.secretAccessKey],
    ["admin", "policy", "attach", "local", "readwrite", "--user", writer.accessKeyId],
    ["admin", "user", "add", "local", reader.accessKeyId, reader.secretAccessKey],
    ["admin", "policy", "attach", "local", "readonly", "--user", reader.accessKeyId],
  ];
  for (const command of commands) {
    const result = await container.exec(["mc", ...command]);
    if (result.exitCode !== 0) {
      await container.stop();
      throw new Error(`mc ${command.join(" ")} failed: ${result.output}`);
    }
  }
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(API_PORT)}`;
  return {
    endpoint,
    bucket,
    baseUrl: `${endpoint}/${bucket}`,
    root: ROOT,
    writer,
    reader,
    stop: async () => {
      await container.stop();
    },
  };
}
