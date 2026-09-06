import type { SftpgoShare, SftpgoShareInput, ShareScope } from "./types.js";

export interface RawSftpgoShare {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly scope: number;
  readonly paths: string[];
  readonly username: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_use_at: number;
  readonly expires_at: number;
  readonly password?: string;
  readonly max_tokens: number;
  readonly used_tokens: number;
  readonly allow_from?: string[];
}

const WRITE_SCOPE = 2;

export function scopeFromWire(scope: number): ShareScope {
  return scope === WRITE_SCOPE ? "write" : "read";
}

export function scopeToWire(scope: ShareScope): number {
  return scope === "write" ? WRITE_SCOPE : 1;
}

/** SFTPGo represents "unset" timestamps (last use, expiry) as 0. */
export function msToDateOrNull(ms: number): Date | null {
  return ms === 0 ? null : new Date(ms);
}

export function toShare(raw: RawSftpgoShare): SftpgoShare {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? "",
    scope: scopeFromWire(raw.scope),
    paths: raw.paths,
    username: raw.username,
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
    lastUseAt: msToDateOrNull(raw.last_use_at),
    expiresAt: msToDateOrNull(raw.expires_at),
    maxTokens: raw.max_tokens,
    usedTokens: raw.used_tokens,
    allowFrom: raw.allow_from ?? [],
    hasPassword: typeof raw.password === "string" && raw.password.length > 0,
  };
}

const REDACTED_PASSWORD = "[**redacted**]";

/**
 * Serializes a SftpgoShareInput for the wire. On update, an undefined
 * password must be sent as the redacted marker so SFTPGo keeps the existing
 * password rather than clearing it; on create there is no existing password
 * to preserve, so the field is simply omitted.
 */
export function shareInputToWire(
  input: SftpgoShareInput,
  isUpdate: boolean,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    name: input.name,
    description: input.description ?? "",
    scope: scopeToWire(input.scope),
    paths: input.paths,
    max_tokens: input.maxTokens ?? 0,
    allow_from: input.allowFrom ?? [],
    expires_at: input.expiresAt == null ? 0 : input.expiresAt.getTime(),
  };

  if (input.password !== undefined) {
    wire.password = input.password;
  } else if (isUpdate) {
    wire.password = REDACTED_PASSWORD;
  }

  return wire;
}
