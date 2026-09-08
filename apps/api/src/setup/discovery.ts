import type { SetupInventoryUser, SetupUserInventoryResponse } from "@fdrive/contracts";

const DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;
const MAX_USERS_RESPONSE_BYTES = 128 * 1024;

export interface DiscoverSftpgoUsersInput {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly otp?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface DiscoverSftpgoUsersDeps {
  readonly fetch: typeof globalThis.fetch;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function adminAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function asAccessToken(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const token = (value as { access_token?: unknown }).access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function readJsonWithin(response: Response, maxBytes: number): Promise<unknown | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) return null;
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function extractUsers(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return null;
  const users =
    (value as { users?: unknown; items?: unknown }).users ?? (value as { items?: unknown }).items;
  return Array.isArray(users) ? users : null;
}

function projectUser(value: unknown): SetupInventoryUser | null {
  if (typeof value !== "object" || value === null) return null;
  const username = (value as { username?: unknown }).username;
  if (typeof username !== "string" || username.length === 0 || username.length > 255) return null;
  const upstreamStatus = (value as { status?: unknown }).status;
  return {
    username,
    status:
      upstreamStatus === 1 || upstreamStatus === "1" || upstreamStatus === "enabled"
        ? "enabled"
        : "disabled",
  };
}

/**
 * Gets one strictly bounded, read-only page from SFTPGo's admin API. Admin
 * credentials and JWT stay in this function and are never returned or
 * persisted. Redirects are rejected before an Authorization header can be
 * forwarded to another host.
 */
export async function discoverSftpgoUsers(
  input: DiscoverSftpgoUsersInput,
  deps: DiscoverSftpgoUsersDeps,
): Promise<SetupUserInventoryResponse> {
  let tokenResponse: Response;
  try {
    tokenResponse = await deps.fetch(endpoint(input.baseUrl, "/api/v2/token"), {
      headers: {
        Authorization: adminAuthorization(input.username, input.password),
        ...(input.otp === undefined ? {} : { "X-SFTPGO-OTP": input.otp }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (tokenResponse.status === 401 || tokenResponse.status === 403) {
    return { ok: false, reason: "denied" };
  }
  if (!tokenResponse.ok) return { ok: false, reason: "unavailable" };

  let token: string | null;
  try {
    token = asAccessToken(await readJsonWithin(tokenResponse, MAX_TOKEN_RESPONSE_BYTES));
  } catch {
    token = null;
  }
  if (token === null) return { ok: false, reason: "unavailable" };

  let usersResponse: Response;
  try {
    const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    usersResponse = await deps.fetch(endpoint(input.baseUrl, `/api/v2/users?${query}`), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (usersResponse.status === 401 || usersResponse.status === 403) {
    return { ok: false, reason: "denied" };
  }
  if (!usersResponse.ok) return { ok: false, reason: "unavailable" };

  let rawUsers: readonly unknown[] | null;
  try {
    rawUsers = extractUsers(await readJsonWithin(usersResponse, MAX_USERS_RESPONSE_BYTES));
  } catch {
    rawUsers = null;
  }
  if (rawUsers === null) return { ok: false, reason: "unavailable" };
  const users = rawUsers.slice(0, input.limit).flatMap((user) => {
    const projected = projectUser(user);
    return projected === null ? [] : [projected];
  });
  return {
    ok: true,
    users,
    nextOffset: rawUsers.length >= input.limit ? input.offset + input.limit : null,
  };
}
