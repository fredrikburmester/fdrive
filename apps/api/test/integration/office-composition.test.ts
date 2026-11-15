import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OfficeOpenResponse,
  PUBLIC_URL_SETTINGS_KEY,
  ROUTES,
  TrashListResponse,
} from "@fdrive/contracts";
import { createDb, createRepos } from "@fdrive/db";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";
import { buildExpectedProof } from "../../src/office/protocol/proof.ts";
import { trashSettingsKey } from "../../src/trash/settings.js";
import { proofKey, proofPair } from "../fixtures/office/harness.ts";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const SHELF = "/Shared with me";
const WOPI_URL = "http://fixture-callback/wopi";
const USERS = ["alice", "bob", "reader", "carol"] as const;
type User = (typeof USERS)[number];

/**
 * Office composed as deployed, with no index root configured: alice keeps
 * `/Team`, which bob and carol may change and reader may only view. alice,
 * bob and reader are the chosen editors; carol is not. Every one of them
 * reaches alice's documents under one id, which follows the files through
 * renames, moves, the Trash and back.
 */
describe("Office over the files folder", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let editor: Server;
  const cookies = new Map<User, string>();

  beforeAll(async () => {
    // A stand-in Document Server: only its discovery, which names the editor
    // pages and the key that signs its callbacks.
    editor = createServer((request, response) => {
      const origin = `http://127.0.0.1:${(editor.address() as AddressInfo).port}`;
      const key = proofKey();
      const actions = ["view", "edit"]
        .map(
          (name) =>
            `<action ext="docx" name="${name}" urlsrc="${origin}/editor?&lt;ui=UI_LLCC&amp;&gt;"/>`,
        )
        .join("");
      response.writeHead(request.url === "/hosting/discovery" ? 200 : 404, {
        "content-type": "text/xml",
      });
      response.end(
        `<wopi-discovery><net-zone name="external-http"><app name="Word">${actions}</app></net-zone><proof-key modulus="${key.modulus}" exponent="${key.exponent}"/></wopi-discovery>`,
      );
    });
    await new Promise<void>((resolve) => editor.listen(0, "127.0.0.1", resolve));
    const editorUrl = `http://127.0.0.1:${(editor.address() as AddressInfo).port}`;
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: USERS.map((username) => ({ username, password: `${username}-pass` })),
        files: { alice: { "/Team/readme.txt": "team", "/Team/Sub/notes.txt": "notes" } },
        grants: [
          { owner: "alice", path: "/Team", grantee: "bob", access: "write" },
          { owner: "alice", path: "/Team", grantee: "carol", access: "write" },
          { owner: "alice", path: "/Team", grantee: "reader", access: "read" },
        ],
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage, ["alice"]);
    const database = createDb(postgres.connectionString);
    try {
      const repos = createRepos(database.db);
      const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
      await repos.settings.set(trashSettingsKey(provider.id), {
        providerId: provider.id,
        revision: 1,
        enabled: true,
        path: "/.trash",
        retentionHours: null,
      });
      await repos.settings.set(PUBLIC_URL_SETTINGS_KEY, { revision: 1, url: "http://fixture-app" });
    } finally {
      await database.close();
    }
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        FDRIVE_OFFICE_PRODUCT: "onlyoffice",
        FDRIVE_OFFICE_URL: editorUrl,
        FDRIVE_OFFICE_PUBLIC_URL: editorUrl,
        FDRIVE_WOPI_URL: WOPI_URL,
      }),
      silentLogger(),
    );
    for (const user of USERS) {
      const login = await call(ROUTES.auth.login, {
        body: { username: user, password: `${user}-pass` },
      });
      expect(login.status).toBe(200);
      cookies.set(user, login.headers.get("set-cookie")?.split(";")[0] ?? "");
    }
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await storage?.stop();
    await postgres?.stop();
    await new Promise((resolve) => editor?.close(resolve));
  }, 180_000);

  async function call(
    path: string,
    options: { user?: User; method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return composed.app.request(path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "x-requested-with": "fdrive",
        "content-type": "application/json",
        ...(options.user === undefined ? {} : { cookie: cookies.get(options.user) ?? "" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function ok(response: Promise<Response>): Promise<unknown> {
    const resolved = await response;
    expect(resolved.status, await resolved.clone().text()).toBeLessThan(300);
    return resolved.json();
  }

  async function open(
    user: User,
    path: string,
    mode: "view" | "edit" = "edit",
  ): Promise<OfficeOpenResponse | number> {
    const response = await call(ROUTES.office.open, { user, body: { path, mode } });
    return response.status === 200
      ? OfficeOpenResponse.parse(await response.json())
      : response.status;
  }

  async function opened(user: User, path: string, mode: "view" | "edit" = "edit") {
    const result = await open(user, path, mode);
    if (typeof result === "number") throw new Error(`${user} could not open ${path}: ${result}`);
    return result;
  }

  /** A WOPI callback as the editor makes it, with the session's token and a signed proof. */
  async function wopi(
    session: OfficeOpenResponse,
    options: { contents?: boolean; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    const token = session.formFields.access_token ?? "";
    const suffix = `/files/${session.fileId}${options.contents ? "/contents" : ""}?access_token=${encodeURIComponent(token)}`;
    const timestamp = BigInt(Date.now()) * 10000n + 621355968000000000n;
    const proof = sign(
      "RSA-SHA256",
      buildExpectedProof(token, `${WOPI_URL}${suffix}`, timestamp),
      proofPair.privateKey,
    ).toString("base64");
    return composed.app.request(
      new Request(`http://untrusted-host/wopi${suffix}`, {
        method: options.headers === undefined ? "GET" : "POST",
        headers: {
          "X-WOPI-TimeStamp": String(timestamp),
          "X-WOPI-Proof": proof,
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
      }),
    );
  }

  it("chooses editors from fdrive's users", async () => {
    const current = (await ok(call(ROUTES.system.office, { user: "alice" }))) as {
      configuration: { revision: number };
    };
    const settings = {
      revision: current.configuration.revision,
      enabled: true,
      editingEnabled: true,
      editorUsernames: ["alice", "bob", "reader", "mallory"],
    };
    const refused = await call(ROUTES.system.office, {
      user: "alice",
      method: "PUT",
      body: settings,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { details: { unknown: ["mallory"] } } });
    await ok(
      call(ROUTES.system.office, {
        user: "alice",
        method: "PUT",
        body: { ...settings, editorUsernames: ["alice", "bob", "reader"] },
      }),
    );
  });

  it("opens a document in a shared folder under its owner's id for everyone", async () => {
    await ok(
      call(ROUTES.office.documents, {
        user: "alice",
        body: { parent: "/Team", name: "plan.docx" },
      }),
    );
    const alices = await opened("alice", "/Team/plan.docx");
    const bobs = await opened("bob", `${SHELF}/Team/plan.docx`);
    expect(bobs.fileId).toBe(alices.fileId);
    expect((await opened("reader", `${SHELF}/Team/plan.docx`, "view")).fileId).toBe(alices.fileId);
    expect((await opened("carol", `${SHELF}/Team/plan.docx`, "view")).fileId).toBe(alices.fileId);

    const alicesInfo = (await (await wopi(alices)).json()) as { OwnerId: string; UserId: string };
    expect(alicesInfo.OwnerId).toBe(alicesInfo.UserId);
    expect(await (await wopi(bobs)).json()).toMatchObject({
      OwnerId: alicesInfo.UserId,
      BaseFileName: "plan.docx",
      UserCanWrite: true,
    });

    // bob saves through the folder alice shares with him, into her file.
    const lock = { "X-WOPI-Override": "LOCK", "X-WOPI-Lock": "bob" };
    expect((await wopi(bobs, { headers: lock })).status).toBe(200);
    const saved = await wopi(bobs, {
      contents: true,
      headers: { "X-WOPI-Override": "PUT", "X-WOPI-Lock": "bob" },
      body: "saved by bob",
    });
    expect(saved.status).toBe(200);
    expect(await readFile(storage.path("alice", "/Team/plan.docx"), "utf8")).toBe("saved by bob");
    expect(
      (await wopi(bobs, { headers: { "X-WOPI-Override": "UNLOCK", "X-WOPI-Lock": "bob" } })).status,
    ).toBe(200);
  });

  it("lets only the chosen editors edit, and never in a folder shared to view only", async () => {
    expect(await open("reader", `${SHELF}/Team/plan.docx`)).toBe(403);
    expect(await open("carol", `${SHELF}/Team/plan.docx`)).toBe(403);
    const created = await call(ROUTES.office.documents, {
      user: "reader",
      body: { parent: `${SHELF}/Team`, name: "reader.docx" },
    });
    expect(created.status).toBe(403);
    const view = await opened("reader", `${SHELF}/Team/plan.docx`, "view");
    expect(await (await wopi(view)).json()).toMatchObject({ UserCanWrite: false, ReadOnly: true });
  });

  it("keeps a document's id across a rename and a move", async () => {
    const { fileId } = await opened("alice", "/Team/plan.docx");
    await ok(
      call(ROUTES.fs.rename, {
        user: "alice",
        body: { path: "/Team/plan.docx", newName: "Plan.docx" },
      }),
    );
    expect((await opened("bob", `${SHELF}/Team/Plan.docx`)).fileId).toBe(fileId);
    await ok(
      call(ROUTES.fs.move, {
        user: "bob",
        body: { path: `${SHELF}/Team/Plan.docx`, target: `${SHELF}/Team/Sub/Plan.docx` },
      }),
    );
    expect((await opened("alice", "/Team/Sub/Plan.docx")).fileId).toBe(fileId);
  });

  it("follows a document into the Trash and back", async () => {
    const { fileId } = await opened("alice", "/Team/Sub/Plan.docx");
    await ok(
      call(ROUTES.fs.delete, {
        user: "alice",
        body: { items: [{ path: "/Team/Sub/Plan.docx", kind: "file" }] },
      }),
    );
    // A new document where it was is another document.
    await ok(
      call(ROUTES.office.documents, {
        user: "alice",
        body: { parent: "/Team/Sub", name: "Plan.docx" },
      }),
    );
    expect((await opened("alice", "/Team/Sub/Plan.docx")).fileId).not.toBe(fileId);
    const trash = TrashListResponse.parse(await ok(call(ROUTES.trash.list, { user: "alice" })));
    const entry = trash.entries.find((item) => item.originalPath === "/Team/Sub/Plan.docx");
    if (entry === undefined) throw new Error("not in the Trash");
    await ok(
      call(ROUTES.trash.restore, {
        user: "alice",
        body: { ids: [entry.id], target: "/Team/Restored.docx" },
      }),
    );
    expect((await opened("bob", `${SHELF}/Team/Restored.docx`)).fileId).toBe(fileId);
  });
});
