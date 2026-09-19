import { generateKeyPairSync, sign } from "node:crypto";
import { parseHomeTemplate, type StorageProvider, scopesFor } from "@fdrive/core";
import { createMemoryOfficeFileRepo, createMemoryWopiLockRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { createMemoryStorage } from "@fdrive/testkit";
import { getCookie } from "hono/cookie";
import type { Logger } from "pino";
import { createApp } from "../../../src/app.js";
import { COOKIE_NAME, hashSessionId } from "../../../src/auth/sessions.js";
import { loadConfig } from "../../../src/config.js";
import { type BusEvent, createEventBus } from "../../../src/events/bus.js";
import { createMetadataService } from "../../../src/metadata/service.js";
import { buildExpectedProof } from "../../../src/office/protocol/proof.ts";
import { registerOfficeRoutes, registerWopiRoutes } from "../../../src/office/routes.ts";
import { createOfficeService } from "../../../src/office/service.ts";
import { createOfficeTokenCodec } from "../../../src/office/tokens.ts";
import type { OfficeConfig, OfficeDeps } from "../../../src/office/types.ts";
import { activityFixture } from "../../activity-fixture.js";
export const proofPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export function proofKey(pair = proofPair) {
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (!jwk.n || !jwk.e) throw new Error("Invalid key");
  return {
    modulus: Buffer.from(jwk.n, "base64url").toString("base64"),
    exponent: Buffer.from(jwk.e, "base64url").toString("base64"),
  };
}
export async function officeHarness(
  options: {
    storage?: StorageProvider;
    storageForUser?: (username: string) => StorageProvider;
    config?: Partial<OfficeConfig>;
    deps?: Partial<OfficeDeps>;
  } = {},
) {
  const repos = createMemoryRepos();
  const now = { value: new Date("2026-09-06T00:00:00Z") };
  const clock = () => now.value;
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://sftpgo" });
  const storage =
    options.storage ??
    createMemoryStorage({
      "/a.docx": "hello",
      "/empty.docx": "",
      "/plain": "hello",
      "/legacy.doc": "legacy",
    });
  const users: {
    account: import("@fdrive/db").Account;
    identity: import("@fdrive/db").Identity;
    session: import("@fdrive/db").Session;
    sessionId: string;
    principal: import("../../../src/auth/principal.js").Principal;
  }[] = [];
  for (const username of ["alice", "bob", "reader"]) {
    const account = await repos.accounts.create({ displayName: username });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: username,
    });
    const sessionId = `session-${username}`;
    const session = await repos.sessions.create({
      idHash: hashSessionId(sessionId),
      accountId: account.id,
      activeIdentityId: identity.id,
      expiresAt: new Date(now.value.getTime() + 86400000),
      userAgent: null,
      ip: null,
    });
    users.push({
      account,
      identity,
      session,
      sessionId,
      principal: {
        accountId: account.id,
        identityId: identity.id,
        username,
        storage,
        isAdmin: false,
      },
    });
  }
  const first = users[0],
    second = users[1],
    third = users[2];
  if (!first || !second || !third) throw new Error("Missing users");
  const alice = first,
    bob = second,
    reader = third;

  const config: OfficeConfig = {
    product: "onlyoffice",
    serverUrl: "http://office-internal",
    publicUrl: "https://app.test/onlyoffice",
    wopiUrl: "http://callback.test/wopi",
    appUrl: "https://app.test",
    maxBytes: 104857600,
    ...options.config,
  };
  const discovery = {
    actions: ["docx", "xlsx", "pptx", "odt", "ods", "odp", ""]
      .flatMap((extension) =>
        ["view", "edit"].map((name) => ({
          extension,
          name,
          url: `http://office-internal/editor?mode=${name}&<ui=UI&>`,
          app: "Office",
          zone: "external-http",
        })),
      )
      .concat([
        {
          extension: "doc",
          name: "convert",
          url: "http://office-internal/convert?",
          app: "Word",
          zone: "external-http",
        },
      ]),
    proofKeys: { current: proofKey() },
  };
  const cache = { get: async () => discovery, refresh: async () => discovery };
  const files = createMemoryOfficeFileRepo();
  const locks = createMemoryWopiLockRepo();
  const activity = activityFixture(clock);
  const bus = createEventBus();
  const events: BusEvent[] = [];
  for (const user of users)
    bus.subscribe({ identityId: user.identity.id }, (event) => events.push(event));
  const deps: OfficeDeps = {
    canEdit: async (actor) =>
      actor.identity.providerId === provider.id &&
      ["alice", "bob"].includes(actor.identity.externalUsername),
    withWriteScope: (providerId, callback) =>
      locks.withFileLock(`office-write:${providerId}`, () => callback({ files, locks })),
    config,
    discovery: cache,
    tokens: createOfficeTokenCodec(Buffer.alloc(32, 7)),
    repos,
    files,
    locks,
    clock,
    location: async (identity) => ({
      providerId: provider.id,
      scopes: scopesFor({
        template: parseHomeTemplate("sftpgo:/shared"),
        username: identity.externalUsername,
      }),
    }),
    storageFactory: (id) =>
      options.storageForUser?.(
        users.find((user) => user.identity.id === id)?.identity.externalUsername ?? "alice",
      ) ?? storage,
    metadata: createMetadataService(repos),
    bus,
    activity: activity.service,
    ...options.deps,
  };
  const service = createOfficeService(deps);
  const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://unused",
      SFTPGO_URL: "http://sftpgo",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger,
    clock,
    version: "test",
    startedAt: clock(),
    principalResolver: async (c) =>
      users.find((u) => u.sessionId === getCookie(c, COOKIE_NAME))?.principal ?? alice.principal,
    registerRoutes: (groups) => registerOfficeRoutes(groups, { service }),
  });
  registerWopiRoutes(app, { service });
  async function open(path = "/a.docx", mode: "view" | "edit" | "convert" = "edit", user = alice) {
    return service.open({ principal: user.principal, sessionId: user.sessionId }, { path, mode });
  }
  async function browser(path: string, body?: unknown, user = alice) {
    return app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `${COOKIE_NAME}=${user.sessionId}`,
        "x-requested-with": "fdrive",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  function signedRequest(
    fileId: string,
    token: string,
    options: {
      contents?: boolean;
      method?: string;
      headers?: Record<string, string>;
      body?: string | ReadableStream<Uint8Array>;
      pair?: typeof proofPair;
      urlSuffix?: string;
    } = {},
  ) {
    const suffix = `/files/${fileId}${options.contents ? "/contents" : ""}?access_token=${encodeURIComponent(token)}${options.urlSuffix ?? ""}`;
    const timestamp = String(BigInt(clock().getTime()) * 10000n + 621355968000000000n);
    const proof = sign(
      "RSA-SHA256",
      buildExpectedProof(token, `${config.wopiUrl}${suffix}`, BigInt(timestamp)),
      (options.pair ?? proofPair).privateKey,
    ).toString("base64");
    return new Request(`http://untrusted-host/wopi${suffix}`, {
      method: options.method ?? "GET",
      headers: { "X-WOPI-TimeStamp": timestamp, "X-WOPI-Proof": proof, ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body, duplex: "half" }),
    });
  }
  async function callback(
    opened: Awaited<ReturnType<typeof open>>,
    options: Parameters<typeof signedRequest>[2] = {},
  ) {
    const token = opened.formFields.access_token;
    if (token === undefined) throw new Error("Missing token");
    return app.request(signedRequest(opened.fileId, token, options));
  }
  return {
    app,
    deps,
    activity,
    service,
    config,
    cache,
    discovery,
    files,
    locks,
    storage,
    repos,
    provider,
    now,
    clock,
    events,
    alice,
    bob,
    reader,
    open,
    browser,
    signedRequest,
    callback,
  };
}
export type OfficeHarness = Awaited<ReturnType<typeof officeHarness>>;
