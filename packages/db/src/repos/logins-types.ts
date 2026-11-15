import type { Identity, Session } from "./types.js";

/** The setting that names the installation's owner once setup is complete. */
export const SETUP_OWNER_KEY = "setup.owner.v1";

/** What `SETUP_OWNER_KEY` holds: setup is complete, and this account owns the installation. */
export interface SetupOwner {
  readonly state: "complete";
  readonly accountId: string;
}

export type LoginErrorCode = "missing_identity" | "setup_claimed";
export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode) {
    super(code);
    this.name = "LoginError";
  }
}
export interface LoginSessionInput {
  readonly idHash: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}
/** A local user to create, with the account and login that come with it. */
export interface NewLocalUser {
  /** The files folder's provider row, which every login names. */
  readonly providerId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly isAdmin: boolean;
  readonly at: Date;
}
export interface SignInInput {
  /** The user's name, matched without regard to case. */
  readonly username: string;
  readonly at: Date;
  readonly session: LoginSessionInput;
}
export interface SignInResult {
  readonly identity: Identity;
  readonly session: Session;
}
/** The writes that span a local user, their account, their login and their sessions. */
export interface LoginRepo {
  /**
   * Creates a local user with an account and a login of the same name, in one
   * transaction. A login a removed user of exactly this name left behind is
   * theirs again. `ConflictError` when the name is taken in any case.
   */
  createUser(input: NewLocalUser): Promise<Identity>;
  /**
   * Setup: creates the owner as `createUser` does, as an administrator, and
   * records them under `SETUP_OWNER_KEY`, in one transaction. Nothing is
   * written when any step fails; `LoginError("setup_claimed")` when another
   * owner is recorded.
   */
  setup(input: Omit<NewLocalUser, "isAdmin">): Promise<Identity>;
  /**
   * Finds the login named `username` in any case, records the sign-in on it
   * and creates the session, in one transaction. The caller has checked the
   * password. `LoginError("missing_identity")` when there is no such login.
   */
  signIn(input: SignInInput): Promise<SignInResult>;
}
export function validateCanonicalUuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new TypeError("Expected canonical UUID");
}
function validateTime(at: Date): void {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
    throw new TypeError("Invalid timestamp");
}
function validateUsername(username: string): void {
  if (
    typeof username !== "string" ||
    username.length < 1 ||
    username.length > 255 ||
    username.includes("\0")
  )
    throw new TypeError("Invalid username");
}
export function validateSessionIdHash(id: string): void {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError("Expected SHA-256 session hash");
}
function validateSessionText(value: string | null, max: number): void {
  if (value !== null && (typeof value !== "string" || value.length > max || value.includes("\0")))
    throw new TypeError("Invalid session metadata");
}
export function validateNewLocalUser(input: Omit<NewLocalUser, "isAdmin">): void {
  validateTime(input.at);
  validateCanonicalUuid(input.providerId);
  validateUsername(input.username);
  if (typeof input.passwordHash !== "string" || input.passwordHash.length === 0)
    throw new TypeError("Invalid password hash");
}
export function validateSignIn(input: SignInInput): void {
  validateTime(input.at);
  validateUsername(input.username);
  validateSessionIdHash(input.session.idHash);
  validateTime(input.session.expiresAt);
  if (input.session.expiresAt.getTime() <= input.at.getTime())
    throw new TypeError("Session must expire after login");
  validateSessionText(input.session.userAgent, 4096);
  validateSessionText(input.session.ip, 255);
}
