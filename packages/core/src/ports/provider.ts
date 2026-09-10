import type { StorageProvider } from "./storage.ts";

/**
 * How a provider form field is rendered and validated. `otp` is a one-time
 * code that is never stored (see `ProviderField.transient`).
 */
export type ProviderFieldKind = "text" | "password" | "otp" | "url";

/**
 * One field of a provider's configuration (set by an administrator when the
 * provider is created) or of its credential (typed by a user at login or
 * link). Drives both the web form and the API's validation, so a provider
 * package never touches either.
 */
export interface ProviderField {
  readonly name: string;
  readonly label: string;
  readonly kind: ProviderFieldKind;
  readonly required: boolean;
  /** One-line help shown under the field. */
  readonly help?: string;
  /** Upper bound on the value's length; defaults to 4096. */
  readonly maxLength?: number;
  /**
   * True for values that are used once and never stored (a one-time code).
   * The API strips transient fields before sealing a credential.
   */
  readonly transient?: boolean;
}

/**
 * What a provider's storage can do. Every flag is static for the provider
 * type; the API combines it with configuration (trash enabled, index roots
 * mapped, Office on) into the per-identity capability list the web reads.
 */
export interface ProviderCapabilities {
  /** Server-side zip of several paths (`StorageProvider.zip`). */
  readonly zip: boolean;
  /** The provider keeps a client-supplied modification time on upload. */
  readonly setModifiedAt: boolean;
  /** `move` is a single server-side operation, never copy-then-delete. */
  readonly atomicMove: boolean;
  /** A recycle folder can exist for this provider (see `ProviderModule.trash`). */
  readonly trash: boolean;
  /** Public shares are possible for this provider. */
  readonly shares: boolean;
  /** Office viewing and editing can be offered for this provider. */
  readonly office: boolean;
  /** Index-backed features (search, thumbnails, folder size) can apply. */
  readonly index: boolean;
  /** Virtual folder mapping between provider paths and index roots applies. */
  readonly scopeMapping: boolean;
}

/**
 * How deleted files reach the recycle folder: the provider does it itself
 * (`native`, SFTPGo's event rule), fdrive moves them on delete (`move`), or
 * there is no trash for this provider (`none`).
 */
export type TrashStrategy = "native" | "move" | "none";

/** One configured provider: a row of `app.providers` as the module sees it. */
export interface ProviderInstance {
  readonly id: string;
  readonly baseUrl: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** A user's credential for one provider, keyed by `credentialFields[].name`. */
export type ProviderCredential = Readonly<Record<string, string>>;

/** A short-lived upstream token minted from a stored credential. */
export interface ProviderToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProviderContext {
  readonly fetch: typeof globalThis.fetch;
}

export interface AuthenticateContext extends ProviderContext {
  /**
   * The username fdrive already knows for this identity, when it
   * re-authenticates an existing login (link, unlink) rather than a new
   * one. A module may fill a missing username field from it and must refuse
   * a credential that names a different user.
   */
  readonly expectedUsername?: string;
}

export interface AuthenticateResult {
  /** The name stored on the identity; unique per provider. */
  readonly externalUsername: string;
  /** A token the authentication already produced, so the API need not mint again. */
  readonly token?: ProviderToken;
}

/**
 * Everything a storage instance needs about the identity it acts for. The
 * API owns unsealing and token caching; the module only asks.
 */
export interface StorageSession {
  readonly externalUsername: string;
  /** Unseals the stored credential; only providers that sign requests themselves need it. */
  getCredential(): Promise<ProviderCredential>;
  /** The current upstream token, minting one if needed; `null` when the module has no `mint`. */
  getToken(): Promise<string | null>;
  /** Forgets the cached token so the next `getToken` mints again. */
  invalidateToken(): Promise<void>;
}

/**
 * A storage backend as a package: everything fdrive needs to configure it,
 * authenticate users against it and read and write files through it. One
 * module per provider type, registered once in the API; routes, the web
 * app, the database schema and the indexer never know which module backs an
 * identity.
 */
export interface ProviderModule {
  readonly type: string;
  readonly label: string;
  /** Shown on the About page; required by some upstream licences (SFTPGo's AGPL notice). */
  readonly attribution?: { readonly name: string; readonly sourceUrl: string };
  readonly configFields: readonly ProviderField[];
  readonly credentialFields: readonly ProviderField[];
  readonly capabilities: ProviderCapabilities;
  readonly trash: TrashStrategy;
  /** Checks that `instance` is reachable and looks like this kind of server. */
  probe(instance: ProviderInstance, ctx: ProviderContext): Promise<ProbeResult>;
  /**
   * Verifies `credential` against `instance`. Throws `StorageError` of kind
   * `unauthorized` for a wrong credential, `forbidden` when the server
   * refuses the user, `upstream_unavailable` when it cannot be reached.
   */
  authenticate(
    instance: ProviderInstance,
    credential: ProviderCredential,
    ctx: AuthenticateContext,
  ): Promise<AuthenticateResult>;
  /**
   * Mints a short-lived token from a stored credential. Absent for providers
   * whose storage signs every request from the credential itself.
   */
  mint?(
    instance: ProviderInstance,
    session: { readonly externalUsername: string; readonly credential: ProviderCredential },
    ctx: ProviderContext,
  ): Promise<ProviderToken>;
  createStorage(
    instance: ProviderInstance,
    session: StorageSession,
    ctx: ProviderContext,
  ): StorageProvider;
}
