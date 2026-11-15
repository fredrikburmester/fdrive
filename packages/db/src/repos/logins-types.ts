import type { Credential, Identity, Session } from "./types.js";

export type LoginErrorCode =
  | "missing_account"
  | "missing_provider"
  | "missing_identity"
  | "invalid_session"
  | "setup_claimed";
export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode) {
    super(code);
    this.name = "LoginError";
  }
}
export interface SealedIdentityCredential {
  readonly ciphertext: Uint8Array;
  readonly keyId: string;
}
export interface LoginSessionInput {
  readonly idHash: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}
export interface LoginVerifiedInput {
  readonly providerId: string;
  readonly username: string;
  /** Endpoint authenticated upstream, checked under a shared provider row lock. */
  readonly verifiedProvider?: {
    readonly type: string;
    readonly baseUrl: string;
    readonly allowDisabled?: boolean;
  };
  readonly at: Date;
  readonly sealCredential: (identityId: string) => SealedIdentityCredential;
  readonly session: LoginSessionInput;
  /** Claim ownership atomically with login persistence; a losing claim rolls back all writes. */
  readonly setupClaim?: { readonly key: string; readonly baseUrl: string };
  /**
   * Revokes every other session of the account in the same transaction. Set
   * when the verified password differs from the stored one: a login with
   * replaced credentials must not leave older sessions alive.
   */
  readonly revokeOtherSessions?: boolean;
  /** Called under the login lock, before any writes; may reject stale authentication. */
  readonly compareCredential?: (identityId: string, current: Credential | null) => boolean;
}
export interface LoginVerifiedResult {
  readonly identity: Identity;
  readonly session: Session;
}
export interface LoginRepo {
  /**
   * The caller must first verify these exact provider credentials with
   * upstream. Finds or creates the account and its one login, stores the
   * sealed credential and creates the session, in one transaction.
   */
  loginVerified(input: LoginVerifiedInput): Promise<LoginVerifiedResult>;
}
export function validateCanonicalUuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new TypeError("Expected canonical UUID");
}
function validateTime(at: Date): void {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
    throw new TypeError("Invalid timestamp");
}
export function validateSessionIdHash(id: string): void {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError("Expected SHA-256 session hash");
}
function validateSessionText(value: string | null, max: number): void {
  if (value !== null && (typeof value !== "string" || value.length > max || value.includes("\0")))
    throw new TypeError("Invalid session metadata");
}
export function validateLoginVerified(input: LoginVerifiedInput): void {
  validateTime(input.at);
  validateCanonicalUuid(input.providerId);
  if (
    typeof input.username !== "string" ||
    input.username.length < 1 ||
    input.username.length > 255 ||
    input.username.includes("\0")
  )
    throw new TypeError("Invalid username");
  if (typeof input.sealCredential !== "function")
    throw new TypeError("Credential sealing callback required");
  validateSessionIdHash(input.session.idHash);
  validateTime(input.session.expiresAt);
  if (input.session.expiresAt.getTime() <= input.at.getTime())
    throw new TypeError("Session must expire after login");
  validateSessionText(input.session.userAgent, 4096);
  validateSessionText(input.session.ip, 255);
  if (input.revokeOtherSessions !== undefined && typeof input.revokeOtherSessions !== "boolean")
    throw new TypeError("Invalid session revocation flag");
}
export function validateSealedIdentityCredential(value: SealedIdentityCredential): void {
  if (
    !(value.ciphertext instanceof Uint8Array) ||
    value.ciphertext.byteLength === 0 ||
    typeof value.keyId !== "string" ||
    value.keyId.length === 0 ||
    value.keyId.length > 255 ||
    value.keyId.includes("\0")
  )
    throw new TypeError("Invalid sealed credential");
}
