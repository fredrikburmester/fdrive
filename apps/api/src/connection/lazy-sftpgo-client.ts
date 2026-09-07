import {
  createSftpgoClient,
  type SftpgoClient,
  type SftpgoPublicShareApi,
  type SftpgoUserApi,
  type SftpgoUserShares,
} from "@fdrive/sftpgo";
import { ApiHttpError } from "../errors.js";
import type { ConnectionStore } from "./store.js";

export interface CreateLazySftpgoClientDeps {
  readonly store: ConnectionStore;
  /** Overrides the `fetch` every resolved `SftpgoClient` uses. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Builds a `SftpgoClient` that resolves the active connection's base URL on
 * every call instead of once at process start, so a connection configured
 * or changed after boot (through `/setup` or the admin connection page)
 * takes effect immediately, without a restart. Building a `SftpgoClient` is
 * cheap, so resolved clients are cached by base URL rather than rebuilt on
 * every call.
 *
 * Throws `ApiHttpError("setup_required", ...)` from any method when no
 * connection is configured yet.
 */
export function createLazySftpgoClient(deps: CreateLazySftpgoClientDeps): SftpgoClient {
  const cache = new Map<string, SftpgoClient>();

  async function resolveClient(): Promise<SftpgoClient> {
    const connection = await deps.store.current();
    if (connection === null) {
      throw new ApiHttpError("setup_required", "no SFTPGo connection is configured yet");
    }
    const cached = cache.get(connection.baseUrl);
    if (cached !== undefined) {
      return cached;
    }
    const created = createSftpgoClient(
      deps.fetch === undefined
        ? { baseUrl: connection.baseUrl }
        : { baseUrl: connection.baseUrl, fetch: deps.fetch },
    );
    cache.set(connection.baseUrl, created);
    return created;
  }

  function lazyUserShares(token: string): SftpgoUserShares {
    return {
      async list() {
        return (await resolveClient()).user(token).shares.list();
      },
      async get(id) {
        return (await resolveClient()).user(token).shares.get(id);
      },
      async create(input) {
        return (await resolveClient()).user(token).shares.create(input);
      },
      async update(id, input) {
        return (await resolveClient()).user(token).shares.update(id, input);
      },
      async remove(id) {
        return (await resolveClient()).user(token).shares.remove(id);
      },
    };
  }

  function lazyUserApi(token: string): SftpgoUserApi {
    return {
      async list(path) {
        return (await resolveClient()).user(token).list(path);
      },
      async statFile(path) {
        return (await resolveClient()).user(token).statFile(path);
      },
      async download(path, options) {
        return (await resolveClient()).user(token).download(path, options);
      },
      async upload(path, body, options) {
        return (await resolveClient()).user(token).upload(path, body, options);
      },
      async mkdir(path, options) {
        return (await resolveClient()).user(token).mkdir(path, options);
      },
      async move(path, target) {
        return (await resolveClient()).user(token).move(path, target);
      },
      async copy(path, target) {
        return (await resolveClient()).user(token).copy(path, target);
      },
      async deleteFile(path) {
        return (await resolveClient()).user(token).deleteFile(path);
      },
      async deleteDir(path) {
        return (await resolveClient()).user(token).deleteDir(path);
      },
      async setModifiedAt(path, modifiedAt) {
        return (await resolveClient()).user(token).setModifiedAt(path, modifiedAt);
      },
      async zip(paths) {
        return (await resolveClient()).user(token).zip(paths);
      },
      async profile() {
        return (await resolveClient()).user(token).profile();
      },
      shares: lazyUserShares(token),
    };
  }

  function lazyPublicShareApi(shareId: string, password?: string): SftpgoPublicShareApi {
    return {
      async list(path) {
        return (await resolveClient()).publicShare(shareId, password).list(path);
      },
      async download(path, options) {
        return (await resolveClient()).publicShare(shareId, password).download(path, options);
      },
      async downloadFile(options) {
        return (await resolveClient()).publicShare(shareId, password).downloadFile(options);
      },
      async zip(options) {
        return (await resolveClient()).publicShare(shareId, password).zip(options);
      },
      async upload(fileName, body, options) {
        return (await resolveClient())
          .publicShare(shareId, password)
          .upload(fileName, body, options);
      },
    };
  }

  return {
    async login(input) {
      return (await resolveClient()).login(input);
    },
    async logout(token) {
      return (await resolveClient()).logout(token);
    },
    user(token) {
      return lazyUserApi(token);
    },
    publicShare(shareId, password) {
      return lazyPublicShareApi(shareId, password);
    },
  };
}
