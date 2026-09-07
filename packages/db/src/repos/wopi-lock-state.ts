export const WOPI_LOCK_TTL_MS = 30 * 60 * 1000;
export const WOPI_FILE_ID_MAX_BYTES = 4096;

export type LockOperation = "lock" | "refresh" | "unlock" | "relock";
export type LockResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly currentLock: string };

export interface LockRequest {
  readonly fileId: string;
  readonly operation: LockOperation;
  readonly lockId: string;
  readonly oldLockId?: string;
  readonly now: Date;
}

export type LockInput = LockRequest;

export interface BoundWopiLockRepo {
  get(now: Date): Promise<string | null>;
  apply(request: Omit<LockRequest, "fileId">): Promise<LockResult>;
}

export interface WopiLockRepo {
  get(fileId: string, now: Date): Promise<string | null>;
  apply(request: LockRequest): Promise<LockResult>;
  /** Callback owns the file lock until it settles. Keep external work bounded. */
  withFileLock<T>(fileId: string, callback: (locked: BoundWopiLockRepo) => Promise<T>): Promise<T>;
}

export interface WopiLockState {
  readonly lockId: string;
  readonly expiresAt: number;
}

export interface WopiLockTransition {
  readonly result: LockResult;
  readonly state: WopiLockState | null;
}

/** Reject invalid identifiers and times before either repository performs IO. */
export function validateWopiFileId(fileId: string): void {
  if (
    fileId.length === 0 ||
    fileId.includes("\0") ||
    Buffer.byteLength(fileId, "utf8") > WOPI_FILE_ID_MAX_BYTES
  ) {
    throw new TypeError("File ID must contain 1–4096 UTF-8 bytes without NUL");
  }
}

export function validateWopiLockRead(fileId: string, now: Date): void {
  validateWopiFileId(fileId);
  if (!Number.isFinite(now.getTime()) || now.getTime() > 8_640_000_000_000_000 - WOPI_LOCK_TTL_MS) {
    throw new TypeError("Invalid lock timestamp");
  }
}

/** NUL cannot be represented by PostgreSQL text; other ASCII bytes are opaque. */
function validateLockId(lockId: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Validate the complete opaque ASCII range except PostgreSQL NUL.
  if (!/^[\x01-\x7f]{1,1024}$/.test(lockId)) {
    throw new TypeError("Lock ID must contain 1–1024 ASCII bytes without NUL");
  }
}

export function validateWopiLockRequest(request: LockRequest): void {
  validateWopiLockRead(request.fileId, request.now);
  validateLockId(request.lockId);
  if (request.oldLockId !== undefined) validateLockId(request.oldLockId);
  switch (request.operation) {
    case "relock":
      if (request.oldLockId === undefined) throw new TypeError("Relock requires oldLockId");
      break;
    case "lock":
    case "refresh":
    case "unlock":
      break;
    default:
      throw new TypeError("Unknown lock operation");
  }
}

/** Lock expiry is inclusive. Matching lock IDs authorize changes across users. */
export function transitionWopiLock(
  current: WopiLockState | null,
  request: LockRequest,
): WopiLockTransition {
  validateWopiLockRequest(request);
  const now = request.now.getTime();
  const live = current !== null && current.expiresAt > now ? current : null;
  const expected = request.operation === "relock" ? request.oldLockId : request.lockId;
  const matches = live !== null && live.lockId === expected;
  if (!matches && !(request.operation === "lock" && live === null)) {
    return { result: { ok: false, currentLock: live?.lockId ?? "" }, state: live };
  }
  return {
    result: { ok: true },
    state:
      request.operation === "unlock"
        ? null
        : { lockId: request.lockId, expiresAt: now + WOPI_LOCK_TTL_MS },
  };
}

/** Test-only implementation. Runtime composition must use createWopiLockRepo. */
export function createMemoryWopiLockRepo(): WopiLockRepo {
  const states = new Map<string, WopiLockState>();
  const queues = new Map<string, Promise<void>>();
  const repo: WopiLockRepo = {
    async get(fileId, now) {
      validateWopiLockRead(fileId, now);
      return repo.withFileLock(fileId, (locked) => locked.get(now));
    },
    async apply(request) {
      validateWopiLockRequest(request);
      return repo.withFileLock(request.fileId, (locked) => locked.apply(request));
    },
    async withFileLock(fileId, callback) {
      validateWopiFileId(fileId);
      const previous = queues.get(fileId) ?? Promise.resolve();
      const release = createSignal();
      const tail = previous.then(() => release.promise);
      queues.set(fileId, tail);
      await previous;
      let state = states.get(fileId) ?? null;
      try {
        const result = await callback({
          async get(now) {
            validateWopiLockRead(fileId, now);
            return state !== null && state.expiresAt > now.getTime() ? state.lockId : null;
          },
          async apply(request) {
            const transition = transitionWopiLock(state, { ...request, fileId });
            if (transition.result.ok) state = transition.state;
            return transition.result;
          },
        });
        if (state === null) states.delete(fileId);
        else states.set(fileId, state);
        return result;
      } finally {
        release.resolve();
        if (queues.get(fileId) === tail) queues.delete(fileId);
      }
    },
  };
  return repo;
}

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}
