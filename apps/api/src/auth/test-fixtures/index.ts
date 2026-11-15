import { MeResponse } from "@fdrive/contracts";
import { createMemoryRepos } from "@fdrive/db/testing";
import type { FilesFolder } from "@fdrive/local";
import type { Logger } from "pino";
import { vi } from "vitest";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import {
  FAST_PASSWORDS,
  filesFolderFixture,
  seedLocalUsers,
  seedStorageRow,
  writeHomeFiles,
} from "../../local/test-fixtures/index.ts";
import {
  createAuthModule,
  createLoginLimiter,
  createPasswordCheck,
  type Installation,
} from "../index.js";
import type { PrincipalResolver } from "../principal.js";
import { createIdentityStorageFactory } from "../storage-factory.ts";

/** The users every harness has, each signing in with `<username>-pass`. */
export const HARNESS_USERS = ["alice", "bob", "carol", "dave", "eve", "frank"] as const;

/**
 * The API's auth routes over the deployment's local folder, as production
 * pins it: a temporary storage root with a home per user holding `/a.docx`
 * and `/report.txt`, and the users in the in-memory repos.
 */
export function authHarness(
  options: {
    principalResolver?: PrincipalResolver;
    /**
     * Wraps the files folder the harness serves, to change how its storage
     * or admission behaves while the users keep their passwords.
     */
    folder?: (folder: FilesFolder) => Pick<FilesFolder, "storage" | "admit">;
    /** The users the folder has, each signing in with `<username>-pass`; `HARNESS_USERS` by default. */
    users?: readonly string[];
    /** What `/auth/me` reports for the installation; Trash off and nothing indexed by default. */
    installation?: () => Promise<Installation>;
  } = {},
) {
  const now = { value: new Date("2026-09-07T00:00:00Z") };
  const clock = () => now.value;
  const repos = createMemoryRepos();
  const master = Buffer.alloc(32, 13);
  const local = filesFolderFixture(repos);
  const config = loadConfig({
    DATABASE_URL: "postgres://test/fdrive",
    FDRIVE_STORAGE_ROOT: local.root,
    FDRIVE_MASTER_KEY: master.toString("base64"),
    FDRIVE_COOKIE_SECURE: "auto",
  });
  const usernames = options.users ?? HARNESS_USERS;
  for (const username of usernames) {
    writeHomeFiles(local.root, username, {
      "/a.docx": `${username} data`,
      "/report.txt": `${username} report`,
    });
  }
  // The password check asks `local.users` whether a password is right and
  // the folder whether a user is still active, so a test can spy on
  // `users.verify` or `users.status` to shape what they see exactly as
  // production would.
  const folder = options.folder?.(local.folder) ?? local.folder;
  const seeded = (async () => {
    await seedLocalUsers(
      repos,
      usernames.map((username) => ({ username, password: `${username}-pass` })),
    );
    return seedStorageRow(repos);
  })();
  const limiter = createLoginLimiter({ clock });
  const checkPassword = createPasswordCheck({ limiter, users: local.users });
  const storageFactory = createIdentityStorageFactory({
    identities: repos.identities,
    folder,
    clock,
  });
  const auth = createAuthModule({
    repos,
    clock,
    config,
    checkPassword,
    storageFactory,
    installation:
      options.installation ??
      (async () => ({ storageName: "Local folder", trash: false, index: false })),
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const app = createApp({
    config,
    clock,
    logger,
    version: "test",
    startedAt: clock(),
    principalResolver: options.principalResolver ?? auth.principalResolver,
    setupRequired: async () => false,
    registerRoutes: (groups) => {
      auth.registerRoutes(groups);
    },
  });
  async function call(
    path: string,
    options: {
      cookie?: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    await seeded;
    return app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function login(username = "alice") {
    const response = await call("/api/v1/auth/login", {
      method: "POST",
      body: { username, password: `${username}-pass` },
    });
    const me = MeResponse.parse(await response.json());
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing cookie");
    return { cookie, me };
  }
  return {
    now,
    clock,
    repos,
    master,
    config,
    /** The storage root: each user's files are under `<root>/<username>`. */
    root: local.root,
    /** What the files folder asks about users; spy on it to shape sign-ins. */
    users: local.users,
    passwords: FAST_PASSWORDS,
    /** Resolves to the local folder's row once it and the users exist; `call` and `login` await it. */
    seeded,
    limiter,
    checkPassword,
    auth,
    logger,
    app,
    call,
    login,
    storageFactory,
  };
}
export type AuthHarness = ReturnType<typeof authHarness>;
export function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing session cookie");
  return cookie;
}
