import type {
  CreateGrantRequest,
  GrantPeopleResponse,
  GrantsResponse,
  OwnedGrant,
  UpdateGrantRequest,
} from "@fdrive/contracts";
import {
  isReservedPath,
  isStorageError,
  joinPath,
  normalizePath,
  splitSegments,
} from "@fdrive/core";
import type { Identity, LocalGrant, Repos } from "@fdrive/db";
import { closedToShares, namedSharedGrants, SHARED_WITH_ME } from "@fdrive/local";
import type { IdentityStorageFactory } from "../auth/storage-factory.js";
import { ApiHttpError } from "../errors.js";

/** A folder shared with a user, named as it appears in their files. */
export interface ReceivedFolder {
  readonly name: string;
  readonly owner: string;
  /** The folder in the owner's files. */
  readonly path: string;
  readonly writable: boolean;
}

export interface LocalGrantService {
  list(identityId: string): Promise<GrantsResponse>;
  people(identityId: string): Promise<GrantPeopleResponse>;
  create(identityId: string, request: CreateGrantRequest): Promise<OwnedGrant>;
  update(identityId: string, id: string, request: UpdateGrantRequest): Promise<OwnedGrant>;
  /** The owner stops sharing, or the person it is shared with leaves. */
  remove(identityId: string, id: string): Promise<void>;
  /** What is shared with the login named `username`, for its index scopes. */
  received(username: string): Promise<ReceivedFolder[]>;
  /** True when `path` (the login's own path) is inside a folder shared with it to view only. */
  isReadOnly(identity: Pick<Identity, "externalUsername">, path: string): Promise<boolean>;
  /**
   * Where `path` (the login's own path) lies in its owner's files: a path in
   * a folder shared with the login is the owner's login and the owner's
   * path; any other is the login's own.
   */
  ownerPath(identityId: string, path: string): Promise<{ identityId: string; path: string }>;
  /**
   * The reverse of `ownerPath`: where `owned` (an owner's login and the
   * owner's path) lies in `identityId`'s files, under `Shared with me` for a
   * login it is shared with, or `null` when that login cannot reach it. The
   * owner cannot reach a path of their own that a folder shared with them
   * hides (`Shared with me/<name>`) either.
   */
  pathFor(identityId: string, owned: { identityId: string; path: string }): Promise<string | null>;
  /**
   * What `onMoved` does, as data a caller applies in its own transaction (a
   * Mac write's receipt): the owner's username and the move, or `null` when
   * no share can follow (a file, or a login that is gone).
   */
  grantMove(
    identityId: string,
    from: string,
    to: string,
    isDir: boolean,
  ): Promise<{ owner: string; from: string; to: string } | null>;
  /** The owner moved a folder in fdrive: its shares follow. */
  onMoved(identityId: string, from: string, to: string, isDir: boolean): Promise<void>;
  /** The owner deleted a folder for good: its shares end. */
  onDeleted(identityId: string, path: string, isDir: boolean): Promise<void>;
}

export interface LocalGrantServiceDeps {
  readonly repos: Pick<Repos, "localGrants" | "localUsers" | "identities">;
  /** The files folder's provider row, which every login is on. */
  readonly storageId: string;
  readonly storageFor: IdentityStorageFactory;
}

const SHELF_PATH = `/${SHARED_WITH_ME}`;

function ownedView(grant: LocalGrant): OwnedGrant {
  return {
    id: grant.id,
    path: grant.path,
    username: grant.granteeUsername,
    access: grant.access,
    createdAt: grant.createdAt.toISOString(),
  };
}

function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

/**
 * Folders users share with each other. fdrive keeps both the users and the
 * files, so a share is a row here and the person it is shared with reaches
 * the owner's folder through their own storage (`Shared with me`), confined
 * to that folder.
 */
export function createLocalGrantService(deps: LocalGrantServiceDeps): LocalGrantService {
  const { repos } = deps;

  async function grantMove(identityId: string, from: string, to: string, isDir: boolean) {
    if (!isDir || from === to) return null;
    const identity = await repos.identities.get(identityId);
    return identity === null ? null : { owner: identity.externalUsername, from, to };
  }

  async function requireLogin(identityId: string): Promise<Identity> {
    const identity = await repos.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "sign in again");
    return identity;
  }

  async function requireOwned(identity: Identity, id: string): Promise<LocalGrant> {
    const grant = await repos.localGrants.get(id);
    if (grant === null || grant.ownerUsername !== identity.externalUsername) {
      throw new ApiHttpError("not_found", "share not found");
    }
    return grant;
  }

  /**
   * What is shared with `username`, named as their storage names it: before
   * the shares their storage refuses (`closedToShares`) are left out.
   */
  async function reachable(username: string) {
    const grants = await repos.localGrants.listReceived(username);
    const named = namedSharedGrants(
      username,
      grants.map((grant) => ({
        owner: grant.ownerUsername,
        path: grant.path,
        writable: grant.access === "write",
        grant,
      })),
    );
    return named.filter(({ grant }) => !closedToShares(grant.path));
  }

  async function received(username: string): Promise<ReceivedFolder[]> {
    return (await reachable(username)).map(({ grant, name }) => ({
      name,
      owner: grant.owner,
      path: grant.path,
      writable: grant.writable,
    }));
  }

  return {
    async list(identityId) {
      const identity = await requireLogin(identityId);
      const username = identity.externalUsername;
      const named = await reachable(username);
      return {
        owned: (await repos.localGrants.listOwned(username)).map(ownedView),
        received: named.map(({ grant: { grant }, name }) => ({
          id: grant.id,
          owner: grant.ownerUsername,
          name,
          path: `${SHELF_PATH}/${name}`,
          access: grant.access,
          createdAt: grant.createdAt.toISOString(),
        })),
      };
    },

    async people(identityId) {
      const identity = await requireLogin(identityId);
      const users = await repos.localUsers.list();
      return {
        usernames: users
          .filter((user) => !user.disabled && user.username !== identity.externalUsername)
          .map((user) => user.username),
      };
    },

    async create(identityId, request) {
      const identity = await requireLogin(identityId);
      const owner = identity.externalUsername;
      const path = normalizePath(request.path);
      if (path === "/") {
        throw new ApiHttpError("bad_request", "share a folder, not all of your files");
      }
      if (splitSegments(path)[0] === SHARED_WITH_ME) {
        throw new ApiHttpError("bad_request", "a folder shared with you cannot be shared on");
      }
      if (isReservedPath(path)) {
        throw new ApiHttpError("bad_request", "fdrive's own folders, like Trash, cannot be shared");
      }
      const grantee = await repos.localUsers.get(request.username);
      if (grantee === null) throw new ApiHttpError("not_found", "no such user");
      if (grantee.username === owner) {
        throw new ApiHttpError("bad_request", "you already have this folder");
      }
      const storage = await deps.storageFor(identityId);
      let kind: string;
      try {
        kind = (await storage.stat(path)).kind;
      } catch (error) {
        if (isStorageError(error) && error.kind === "not_found") {
          throw new ApiHttpError("not_found", "folder not found");
        }
        throw error;
      }
      if (kind !== "dir") throw new ApiHttpError("bad_request", "only folders can be shared");
      return ownedView(
        await repos.localGrants.put({
          ownerUsername: owner,
          path,
          granteeUsername: grantee.username,
          access: request.access,
        }),
      );
    },

    async update(identityId, id, request) {
      const identity = await requireLogin(identityId);
      const grant = await requireOwned(identity, id);
      return ownedView(
        await repos.localGrants.put({
          ownerUsername: grant.ownerUsername,
          path: grant.path,
          granteeUsername: grant.granteeUsername,
          access: request.access,
        }),
      );
    },

    async remove(identityId, id) {
      const identity = await requireLogin(identityId);
      const grant = await repos.localGrants.get(id);
      const username = identity.externalUsername;
      if (
        grant === null ||
        (grant.ownerUsername !== username && grant.granteeUsername !== username)
      ) {
        throw new ApiHttpError("not_found", "share not found");
      }
      await repos.localGrants.delete(grant.id);
    },

    received,

    async isReadOnly(identity, path) {
      const target = normalizePath(path);
      const folders = await received(identity.externalUsername);
      return folders.some(
        (folder) => !folder.writable && under(target, `${SHELF_PATH}/${folder.name}`),
      );
    },

    async ownerPath(identityId, path) {
      const own = { identityId, path };
      const segments = splitSegments(path);
      if (segments[0] !== SHARED_WITH_ME || segments.length < 2) return own;
      const identity = await repos.identities.get(identityId);
      if (identity === null) return own;
      const folder = (await received(identity.externalUsername)).find(
        (candidate) => candidate.name === segments[1],
      );
      // No such shared folder: an ordinary folder of that name, or nothing.
      if (folder === undefined) return own;
      // A grant goes with its owner's user, whose login exists as long as they do.
      const owner = await repos.identities.findByProviderUsername(deps.storageId, folder.owner);
      if (owner === null) throw new Error("the owner of a shared folder has no login");
      return { identityId: owner.id, path: joinPath(folder.path, ...segments.slice(2)) };
    },

    async pathFor(identityId, owned) {
      const login = await repos.identities.get(identityId);
      if (login === null) return null;
      const folders = await received(login.externalUsername);
      if (owned.identityId === identityId) {
        const segments = splitSegments(owned.path);
        const hidden =
          segments[0] === SHARED_WITH_ME && folders.some((folder) => folder.name === segments[1]);
        return hidden ? null : owned.path;
      }
      const owner = await repos.identities.get(owned.identityId);
      if (owner === null) return null;
      // The most specific folder, when one inside another is shared too.
      const folder = folders
        .filter((candidate) => candidate.owner === owner.externalUsername)
        .filter((candidate) => under(owned.path, candidate.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (folder === undefined) return null;
      const inside = splitSegments(owned.path).slice(splitSegments(folder.path).length);
      return joinPath(SHELF_PATH, folder.name, ...inside);
    },

    grantMove,

    async onMoved(identityId, from, to, isDir) {
      const move = await grantMove(identityId, from, to, isDir);
      if (move !== null) await repos.localGrants.movePrefix(move.owner, move.from, move.to);
    },

    async onDeleted(identityId, path, isDir) {
      if (!isDir) return;
      const identity = await repos.identities.get(identityId);
      if (identity === null) return;
      await repos.localGrants.deletePrefix(identity.externalUsername, path);
    },
  };
}
