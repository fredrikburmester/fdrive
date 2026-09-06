/** A storage backend instance, e.g. one SFTPGo server. */
export interface Provider {
  readonly id: string;
  readonly type: string;
  readonly baseUrl: string;
  readonly createdAt: Date;
}

export interface ProviderRepo {
  /**
   * Finds the provider for (type, baseUrl), creating it when it does not
   * exist yet. Idempotent: repeated calls with the same input always
   * return the same row.
   */
  ensure(input: { type: string; baseUrl: string }): Promise<Provider>;
}

/** An fdrive user, created on first successful login. */
export interface Account {
  readonly id: string;
  readonly displayName: string | null;
  readonly createdAt: Date;
  readonly isAdmin: boolean;
}

export interface AccountRepo {
  create(input: { displayName: string | null }): Promise<Account>;
  get(id: string): Promise<Account | null>;
  /** Sets the account's admin flag. A no-op when the account does not exist. */
  setAdmin(id: string, isAdmin: boolean): Promise<void>;
}

/** A login on a provider. Belongs to exactly one account. */
export interface Identity {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly externalUsername: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
}

export interface IdentityRepo {
  findByProviderUsername(providerId: string, username: string): Promise<Identity | null>;
  create(input: {
    accountId: string;
    providerId: string;
    externalUsername: string;
  }): Promise<Identity>;
  get(id: string): Promise<Identity | null>;
  listByAccount(accountId: string): Promise<Identity[]>;
  touchLogin(id: string, at: Date): Promise<void>;
}

/**
 * The envelope-encrypted SFTPGo password for one identity, plus the
 * currently cached (also sealed) SFTPGo JWT and its expiry, when one has
 * been minted.
 */
export interface Credential {
  readonly identityId: string;
  readonly ciphertext: Uint8Array;
  readonly keyId: string;
  readonly cachedToken: string | null;
  readonly cachedTokenExpiresAt: Date | null;
  readonly updatedAt: Date;
}

export interface CredentialRepo {
  put(input: { identityId: string; ciphertext: Uint8Array; keyId: string }): Promise<void>;
  get(identityId: string): Promise<Credential | null>;
  setCachedToken(
    identityId: string,
    token: { sealed: string; expiresAt: Date } | null,
  ): Promise<void>;
}

/** An opaque server-side session. The cookie carries the raw id; only its hash is stored. */
export interface Session {
  readonly idHash: string;
  readonly accountId: string;
  readonly activeIdentityId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface SessionRepo {
  create(input: {
    idHash: string;
    accountId: string;
    activeIdentityId: string | null;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
  }): Promise<Session>;
  /** Returns null both when the session does not exist and when it has expired as of `now`. */
  getByIdHash(idHash: string, now: Date): Promise<Session | null>;
  touch(idHash: string, input: { lastSeenAt: Date; expiresAt: Date }): Promise<void>;
  delete(idHash: string): Promise<void>;
  /** Deletes every session whose expiry is at or before `now`. Returns the number deleted. */
  deleteExpired(now: Date): Promise<number>;
}

/**
 * Key/value settings storage over `app.settings`. Values are stored as
 * JSON; callers are responsible for the shape at a given key.
 */
export interface SettingsRepo {
  /** Returns the value stored at `key`, or null when no row exists. */
  get<T>(key: string): Promise<T | null>;
  /** Upserts the value stored at `key`. */
  set(key: string, value: unknown): Promise<void>;
  /** Returns every setting as a plain object keyed by its setting key. */
  all(): Promise<Record<string, unknown>>;
}

/** The full set of app-schema repositories, bundled for convenient wiring. */
export interface Repos {
  readonly providers: ProviderRepo;
  readonly accounts: AccountRepo;
  readonly identities: IdentityRepo;
  readonly credentials: CredentialRepo;
  readonly sessions: SessionRepo;
  readonly settings: SettingsRepo;
}
