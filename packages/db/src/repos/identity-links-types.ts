import type { Identity, Session } from "./types.js";

export type IdentityLinksErrorCode =
  | "missing_account"
  | "missing_provider"
  | "missing_identity"
  | "forbidden"
  | "last_identity"
  | "invalid_session";
export class IdentityLinksError extends Error {
  constructor(readonly code: IdentityLinksErrorCode) {
    super(code);
    this.name = "IdentityLinksError";
  }
}
export interface SealedIdentityCredential {
  readonly ciphertext: Uint8Array;
  readonly keyId: string;
}
export interface LinkVerifiedInput {
  readonly requestingSessionIdHash?: string;
  readonly accountId: string;
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
}
export interface UnlinkIdentityInput {
  readonly requestingSessionIdHash?: string;
  readonly accountId: string;
  readonly identityId: string;
  readonly at: Date;
}
export interface UnlinkIdentityResult {
  readonly identity: Identity;
  readonly remainingIdentityId: string;
}
export interface SwitchActiveIdentityInput extends UnlinkIdentityInput {
  readonly sessionIdHash: string;
}
export interface LoginSessionInput {
  readonly idHash: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}
export interface LoginVerifiedInput
  extends Omit<LinkVerifiedInput, "accountId" | "requestingSessionIdHash"> {
  readonly session: LoginSessionInput;
  /**
   * Revokes every other session of the identity's account in the same
   * transaction. Set when the verified password differs from the stored one:
   * a login with replaced credentials must not leave older sessions alive.
   */
  readonly revokeOtherSessions?: boolean;
}
export interface LoginVerifiedResult {
  readonly identity: Identity;
  readonly session: Session;
}
export interface RotateSessionInput {
  readonly accountId: string;
  readonly oldSessionIdHash: string;
  readonly newSessionIdHash: string;
  readonly activeIdentityId: string;
  readonly at: Date;
}
export interface IdentityLinksRepo {
  loginVerified(input: LoginVerifiedInput): Promise<LoginVerifiedResult>;
  rotateSession(input: RotateSessionInput): Promise<Session>;
  /** The caller must first verify these exact provider credentials with upstream. */
  linkVerified(input: LinkVerifiedInput): Promise<Identity>;
  unlink(input: UnlinkIdentityInput): Promise<UnlinkIdentityResult>;
  switchActive(input: SwitchActiveIdentityInput): Promise<void>;
}
export function validateIdentityLinkId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new TypeError("Expected canonical UUID");
}
function validateAccountTime(input: { accountId: string; at: Date }): void {
  validateIdentityLinkId(input.accountId);
  validateTime(input.at);
}
function validateTime(at: Date): void {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
    throw new TypeError("Invalid timestamp");
}
export function validateSessionIdHash(id: string): void {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError("Expected SHA-256 session hash");
}
function validateVerifiedInput(input: Omit<LinkVerifiedInput, "accountId">): void {
  validateTime(input.at);
  validateIdentityLinkId(input.providerId);
  if (
    typeof input.username !== "string" ||
    input.username.length < 1 ||
    input.username.length > 255 ||
    input.username.includes("\0")
  )
    throw new TypeError("Invalid username");
  if (typeof input.sealCredential !== "function")
    throw new TypeError("Credential sealing callback required");
}
export function validateLinkVerified(input: LinkVerifiedInput): void {
  validateAccountTime(input);
  validateVerifiedInput(input);
  if (input.requestingSessionIdHash !== undefined)
    validateSessionIdHash(input.requestingSessionIdHash);
}
function validateSessionText(value: string | null, max: number): void {
  if (value !== null && (typeof value !== "string" || value.length > max || value.includes("\0")))
    throw new TypeError("Invalid session metadata");
}
export function validateLoginVerified(input: LoginVerifiedInput): void {
  validateVerifiedInput(input);
  validateSessionIdHash(input.session.idHash);
  validateTime(input.session.expiresAt);
  if (input.session.expiresAt.getTime() <= input.at.getTime())
    throw new TypeError("Session must expire after login");
  validateSessionText(input.session.userAgent, 4096);
  validateSessionText(input.session.ip, 255);
  if (input.revokeOtherSessions !== undefined && typeof input.revokeOtherSessions !== "boolean")
    throw new TypeError("Invalid session revocation flag");
}
export function validateRotateSession(input: RotateSessionInput): void {
  validateAccountTime(input);
  validateIdentityLinkId(input.activeIdentityId);
  validateSessionIdHash(input.oldSessionIdHash);
  validateSessionIdHash(input.newSessionIdHash);
  if (input.oldSessionIdHash === input.newSessionIdHash)
    throw new TypeError("Session rotation requires a new hash");
}
export function validateUnlinkIdentity(input: UnlinkIdentityInput): void {
  validateAccountTime(input);
  validateIdentityLinkId(input.identityId);
  if (input.requestingSessionIdHash !== undefined)
    validateSessionIdHash(input.requestingSessionIdHash);
}
export function validateSwitchActiveIdentity(input: SwitchActiveIdentityInput): void {
  validateUnlinkIdentity(input);
  validateSessionIdHash(input.sessionIdHash);
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
