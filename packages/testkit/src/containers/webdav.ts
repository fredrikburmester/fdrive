import type { Content } from "testcontainers";
import { GenericContainer, Wait } from "testcontainers";
import { seedFileLayout } from "../file-layout.js";
import type { SeedFiles } from "../seed-data.js";

const DAV_ROOT = "/usr/local/apache2/htdocs/dav";
const PASSWORD_FILE = "/tmp/dav-passwords";

/** A login of the Apache WebDAV server and its home, `/dav/<username>/`. */
export interface ApacheWebdavUser {
  readonly username: string;
  readonly password: string;
  /** Refuses every change with 403, as a server that grants this login read access only. */
  readonly readOnly?: boolean;
}

export interface StartApacheWebdavOptions {
  /**
   * Logins, each with a home of its own at `/dav/<username>/` that only it
   * can open. Without this the server has one login, alice, whose home is
   * `/dav/` itself.
   */
  readonly users?: readonly ApacheWebdavUser[];
  /** Files by owner and virtual path, seeded into each user's home (multi-user only). */
  readonly files?: SeedFiles;
}

export interface ApacheWebdavContainer {
  /** The first login's home, e.g. `http://localhost:32771/dav/`. */
  readonly baseUrl: string;
  /** The first login's credential. */
  readonly credential: { readonly username: string; readonly password: string };
  /** Every login with its home. */
  readonly users: readonly {
    readonly username: string;
    readonly password: string;
    readonly baseUrl: string;
  }[];
  stop(): Promise<void>;
}

const DEFAULT_CREDENTIAL: ApacheWebdavUser = {
  username: "alice",
  password: "fdrive-test-password",
};

/** A shell-safe single-quoted word. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function directory(path: string, user: string | null, readOnly: boolean): string {
  const require = user === null ? "Require valid-user" : `Require user ${user}`;
  return `
<Directory ${path}>
  Dav On
  Options Indexes
  AuthType Basic
  AuthName "fdrive integration"
  AuthUserFile ${PASSWORD_FILE}
  ${
    readOnly
      ? `<Limit GET HEAD OPTIONS PROPFIND>
    ${require}
  </Limit>
  <LimitExcept GET HEAD OPTIONS PROPFIND>
    Require all denied
  </LimitExcept>`
      : require
  }
</Directory>
`;
}

/**
 * Disposable Apache mod_dav server: a class 1 WebDAV server with collection
 * redirects, real locks and per-login homes. Each user in `options.users`
 * gets `/dav/<username>/`, which only that login can open; a `readOnly`
 * login can read its home but every change is refused.
 */
export async function startApacheWebdav(
  options: StartApacheWebdavOptions = {},
): Promise<ApacheWebdavContainer> {
  const multiUser = options.users !== undefined;
  const users: readonly ApacheWebdavUser[] = options.users ?? [DEFAULT_CREDENTIAL];
  if (users.length === 0) throw new Error("startApacheWebdav needs at least one user");
  for (const user of users) {
    if (!/^[a-z][a-z0-9-]*$/.test(user.username)) {
      throw new Error(`startApacheWebdav: unsupported username ${JSON.stringify(user.username)}`);
    }
  }
  const config = [
    "DavLockDB /tmp/DavLock",
    ...(multiUser
      ? users.map((user) =>
          directory(`${DAV_ROOT}/${user.username}`, user.username, user.readOnly === true),
        )
      : [directory(DAV_ROOT, null, false)]),
  ].join("\n");
  const seeded: { content: Content; target: string; mode: number }[] = multiUser
    ? seedFileLayout(options.files ?? {}, { dataDir: DAV_ROOT }).map((file) => ({
        content: file.content,
        target: file.containerPath.slice(1),
        mode: 0o644,
      }))
    : [];
  const container = await new GenericContainer("httpd:2.4")
    .withCopyContentToContainer([{ content: config, target: "/tmp/dav.conf" }, ...seeded])
    .withCommand([
      "sh",
      "-c",
      [
        "sed -i 's/^#LoadModule dav_module/LoadModule dav_module/;s/^#LoadModule dav_fs_module/LoadModule dav_fs_module/' conf/httpd.conf",
        "cat /tmp/dav.conf >> conf/httpd.conf",
        "mkdir -p htdocs/dav",
        ...(multiUser ? users.map((user) => `mkdir -p htdocs/dav/${user.username}`) : []),
        ...users.map(
          (user, index) =>
            `htpasswd -b${index === 0 ? "c" : ""} ${PASSWORD_FILE} ${quote(user.username)} ${quote(user.password)}`,
        ),
        "chown -R www-data:www-data htdocs/dav",
        "exec httpd-foreground",
      ].join(" && "),
    ])
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forHttp("/", 80))
    .start();
  const origin = `http://${container.getHost()}:${container.getMappedPort(80)}`;
  const homes = users.map((user) => ({
    username: user.username,
    password: user.password,
    baseUrl: multiUser ? `${origin}/dav/${user.username}/` : `${origin}/dav/`,
  }));
  const first = homes[0] as (typeof homes)[number];
  return {
    baseUrl: first.baseUrl,
    credential: { username: first.username, password: first.password },
    users: homes,
    stop: async () => {
      await container.stop();
    },
  };
}
