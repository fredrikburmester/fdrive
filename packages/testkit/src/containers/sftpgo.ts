import { fileURLToPath } from "node:url";
import type { Content } from "testcontainers";
import { GenericContainer, Wait } from "testcontainers";
import { seedFileLayout } from "../file-layout.js";
import {
  SEED_FILES,
  SEED_FOLDERS,
  SEED_USERS,
  type SeedFolder,
  type SeedUser,
} from "../seed-data.js";
import { buildSftpgoDump } from "../sftpgo-dump.js";

const DEFAULT_IMAGE = "drakkan/sftpgo:v2.7.5";
const HTTP_PORT = 8080;
/** SFTPGo's own WebDAV binding: the real class 1 server the WebDAV provider is verified against. */
const WEBDAV_PORT = 8081;
const SFTP_PORT = 2022;
const FTP_PORT = 2121;
const DATA_DIR = "/srv/sftpgo/data";
const SEED_DUMP_CONTAINER_PATH = "/tmp/seed.json";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin-password-for-tests";
const FILE_MODE = 0o644;

/** Strips a leading slash so a path can be used as a tar entry extracted at "/". */
function toArchiveTarget(absolutePath: string): string {
  return absolutePath.startsWith("/") ? absolutePath.slice(1) : absolutePath;
}

export interface StartSftpgoOptions {
  readonly image?: string;
  /** Builds the pinned integration image and explicitly qualifies these fixture users. */
  readonly enforcedWriteUsers?: readonly string[];
  readonly users?: readonly SeedUser[];
  readonly folders?: readonly SeedFolder[];
  readonly files?: Readonly<Record<string, Record<string, string>>>;
  /** When given, seeds the Event Manager recycle-folder rule at this virtual path. */
  readonly trash?: { readonly path: string };
}

export interface SftpgoContainer {
  readonly baseUrl: string;
  /** The WebDAV endpoint of the same server and users, e.g. `http://localhost:32771`. */
  readonly webdavUrl: string;
  readonly sftp: { readonly host: string; readonly port: number };
  readonly ftp: { readonly host: string; readonly port: number };
  readonly users: readonly SeedUser[];
  stop(): Promise<void>;
}

/**
 * Finds the seed user named "alice" among the effective user list, used to
 * verify that the seed data actually loaded after the container starts.
 * Throws immediately (before starting any container) if the caller passed a
 * custom user list without an "alice", since the health check below would
 * otherwise fail in a confusing way.
 */
function findAliceOrThrow(users: readonly SeedUser[]): SeedUser {
  const alice = users.find((user) => user.username === "alice");
  if (!alice) {
    throw new Error(
      'startSftpgo requires a seed user named "alice" to verify that the dump loaded; ' +
        "pass one in options.users or omit options.users to use the defaults.",
    );
  }
  return alice;
}

/**
 * Starts a disposable SFTPGo container, seeded via SFTPGO_LOADDATA_FROM with
 * the given (or default) users, folders, and files, and verifies the seed
 * actually loaded by logging in as "alice" before returning.
 */
export async function startSftpgo(options: StartSftpgoOptions = {}): Promise<SftpgoContainer> {
  const users = options.users ?? SEED_USERS;
  const folders = options.folders ?? SEED_FOLDERS;
  const files = options.files ?? SEED_FILES;
  const alice = findAliceOrThrow(users);

  const dump = buildSftpgoDump(users, folders, {
    dataDir: DATA_DIR,
    ...(options.trash === undefined ? {} : { trash: options.trash }),
  });
  const seededFiles = seedFileLayout(files, { dataDir: DATA_DIR });

  const contentsToCopy: { content: Content; target: string; mode: number }[] = [
    {
      content: JSON.stringify(dump),
      target: toArchiveTarget(SEED_DUMP_CONTAINER_PATH),
      mode: FILE_MODE,
    },
    ...seededFiles.map(({ containerPath, content }) => ({
      content,
      target: toArchiveTarget(containerPath),
      mode: FILE_MODE,
    })),
  ];

  const image =
    options.image ??
    (options.enforcedWriteUsers ? process.env.FDRIVE_TEST_SFTPGO_WRITE_IMAGE : undefined);
  const container =
    options.enforcedWriteUsers && !image
      ? await GenericContainer.fromDockerfile(
          fileURLToPath(new URL("../../../../integrations/sftpgo/", import.meta.url)),
        )
          .withBuildkit()
          .withCache(true)
          .build()
      : new GenericContainer(image ?? DEFAULT_IMAGE);
  const started = await container
    .withExposedPorts(HTTP_PORT, WEBDAV_PORT, SFTP_PORT, FTP_PORT)
    .withCopyContentToContainer(contentsToCopy)
    .withEnvironment({
      SFTPGO_HTTPD__BINDINGS__0__PORT: String(HTTP_PORT),
      SFTPGO_HTTPD__BINDINGS__0__ADDRESS: "",
      SFTPGO_WEBDAVD__BINDINGS__0__PORT: String(WEBDAV_PORT),
      SFTPGO_WEBDAVD__BINDINGS__0__ADDRESS: "",
      SFTPGO_SFTPD__BINDINGS__0__PORT: String(SFTP_PORT),
      SFTPGO_FTPD__BINDINGS__0__PORT: String(FTP_PORT),
      ...(options.enforcedWriteUsers
        ? {
            FDRIVE_SFTPGO_WRITE_ENFORCEMENT: "fdrive-local-v1",
            FDRIVE_SFTPGO_WRITE_USERS: options.enforcedWriteUsers.join(","),
          }
        : {}),
      SFTPGO_LOADDATA_FROM: SEED_DUMP_CONTAINER_PATH,
      SFTPGO_LOADDATA_MODE: "0",
      SFTPGO_DEFAULT_ADMIN_USERNAME: ADMIN_USERNAME,
      SFTPGO_DEFAULT_ADMIN_PASSWORD: ADMIN_PASSWORD,
      // The stock config ships with create_default_admin: false, so the
      // default admin env vars above are otherwise silently ignored.
      SFTPGO_DATA_PROVIDER__CREATE_DEFAULT_ADMIN: "true",
    })
    .withWaitStrategy(Wait.forHttp("/healthz", HTTP_PORT).forStatusCode(200))
    .start();

  // withCopyContentToContainer extracts as root, so newly seeded
  // directories end up root-owned and not writable by the sftpgo process
  // (uid 1000). Reassign ownership so operations like mkdir/upload that
  // SFTPGo's own permission checks allow are not then blocked by the
  // underlying filesystem.
  await started.exec(["chown", "-R", "1000:1000", DATA_DIR], { user: "root" });

  const baseUrl = `http://${started.getHost()}:${started.getMappedPort(HTTP_PORT)}`;
  const webdavUrl = `http://${started.getHost()}:${started.getMappedPort(WEBDAV_PORT)}`;

  await verifySeedLoaded(baseUrl, alice, started.stop.bind(started));

  return {
    baseUrl,
    webdavUrl,
    sftp: { host: started.getHost(), port: started.getMappedPort(SFTP_PORT) },
    ftp: { host: started.getHost(), port: started.getMappedPort(FTP_PORT) },
    users,
    stop: async () => {
      await started.stop();
    },
  };
}

async function verifySeedLoaded(
  baseUrl: string,
  alice: SeedUser,
  stopContainer: () => Promise<unknown>,
): Promise<void> {
  const credentials = Buffer.from(`${alice.username}:${alice.password}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v2/user/token`, {
      headers: { Authorization: `Basic ${credentials}` },
    });
  } catch (error) {
    await stopContainer();
    throw new Error(
      `startSftpgo: failed to reach ${baseUrl}/api/v2/user/token while verifying the seed load: ${String(error)}`,
    );
  }

  if (response.status !== 200) {
    const body = await response.text();
    await stopContainer();
    throw new Error(
      `startSftpgo: seed data did not load correctly; logging in as "${alice.username}" returned ` +
        `${response.status} instead of 200. Response body: ${body}`,
    );
  }
}
