import { describe, expect, it } from "vitest";
import {
  ConnectionTestResponse,
  SetupCompleteRequest,
  SetupMode,
  SetupStatusResponse,
  SetupTestRequest,
} from "./setup";

const FIELD = { name: "username", label: "Username", kind: "text", required: true };
const WEBDAV_TYPE = {
  type: "webdav",
  label: "WebDAV",
  configFields: [],
  credentialFields: [FIELD],
  capabilities: {
    zip: false,
    setModifiedAt: false,
    atomicMove: true,
    trash: true,
    shares: true,
    office: true,
    index: false,
    shareWithPeople: false,
  },
};

describe("SetupMode", () => {
  it("is local or provider", () => {
    expect(SetupMode.options).toEqual(["local", "provider"]);
    expect(SetupMode.safeParse("sftpgo").success).toBe(false);
  });
});

describe("SetupStatusResponse", () => {
  it("parses local mode, which offers no provider types", () => {
    const status = { required: true, mode: "local", types: [] };
    expect(SetupStatusResponse.parse(status)).toEqual(status);
  });

  it("parses provider mode with the types setup can connect", () => {
    const status = { required: true, mode: "provider", types: [WEBDAV_TYPE] };
    expect(SetupStatusResponse.parse(status)).toEqual(status);
  });

  it("rejects a missing mode or types and an unknown mode", () => {
    expect(SetupStatusResponse.safeParse({ required: true, types: [] }).success).toBe(false);
    expect(SetupStatusResponse.safeParse({ required: true, mode: "local" }).success).toBe(false);
    expect(
      SetupStatusResponse.safeParse({ required: true, mode: "sftpgo", types: [] }).success,
    ).toBe(false);
  });
});

describe("SetupTestRequest", () => {
  it("accepts a known type at an http(s) baseUrl, with optional configuration", () => {
    expect(SetupTestRequest.safeParse({ type: "webdav", baseUrl: "http://dav.test" }).success).toBe(
      true,
    );
    expect(
      SetupTestRequest.parse({
        type: "s3",
        baseUrl: "https://s3.test/bucket",
        config: { region: "eu-north-1" },
      }),
    ).toEqual({ type: "s3", baseUrl: "https://s3.test/bucket", config: { region: "eu-north-1" } });
  });

  it("rejects a non-http(s) baseUrl, an unknown type and extra fields", () => {
    expect(SetupTestRequest.safeParse({ type: "webdav", baseUrl: "not-a-url" }).success).toBe(
      false,
    );
    expect(SetupTestRequest.safeParse({ type: "sftpgo", baseUrl: "http://a" }).success).toBe(false);
    expect(SetupTestRequest.safeParse({ baseUrl: "http://a" }).success).toBe(false);
    expect(
      SetupTestRequest.safeParse({ type: "webdav", baseUrl: "http://a", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("ConnectionTestResponse", () => {
  it("parses a valid payload", () => {
    expect(ConnectionTestResponse.parse({ ok: true, detail: "reachable" })).toEqual({
      ok: true,
      detail: "reachable",
    });
  });

  it("rejects a missing detail", () => {
    expect(ConnectionTestResponse.safeParse({ ok: true }).success).toBe(false);
  });
});

describe("SetupCompleteRequest: local", () => {
  const valid = { kind: "local", username: "alice", password: "correct-horse" };

  it("accepts a username and password", () => {
    expect(SetupCompleteRequest.parse(valid)).toEqual(valid);
  });

  it("trims the username", () => {
    expect(SetupCompleteRequest.parse({ ...valid, username: "  alice  " })).toEqual(valid);
  });

  it("rejects usernames that cannot be a home folder", () => {
    for (const username of ["", ".alice", "a/b", "a b", "x".repeat(256)]) {
      expect(SetupCompleteRequest.safeParse({ ...valid, username }).success).toBe(false);
    }
  });

  it("rejects a password that is too short or too long", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, password: "short" }).success).toBe(false);
    expect(SetupCompleteRequest.safeParse({ ...valid, password: "x".repeat(1025) }).success).toBe(
      false,
    );
  });

  it("rejects provider fields", () => {
    expect(SetupCompleteRequest.safeParse({ ...valid, baseUrl: "http://a" }).success).toBe(false);
  });
});

describe("SetupCompleteRequest: provider", () => {
  const valid = {
    kind: "provider",
    type: "webdav",
    baseUrl: "http://dav.test:8080",
    credential: { username: "alice", password: "hunter2" },
  };

  it("accepts a storage and a credential", () => {
    expect(SetupCompleteRequest.parse(valid)).toEqual(valid);
    expect(SetupCompleteRequest.parse({ ...valid, config: { region: "x" } })).toEqual({
      ...valid,
      config: { region: "x" },
    });
  });

  it("trims optional provider names and rejects explicit invalid names", () => {
    const parse = (label: string) => {
      const parsed = SetupCompleteRequest.parse({ ...valid, label });
      return parsed.kind === "provider" ? parsed.label : undefined;
    };
    expect(parse("  Home storage  ")).toBe("Home storage");
    expect(parse("x".repeat(120))).toHaveLength(120);
    for (const label of ["", " \t\n ", "x".repeat(121)]) {
      expect(SetupCompleteRequest.safeParse({ ...valid, label }).success).toBe(false);
    }
  });

  it("rejects a missing credential, an unknown type, a bad URL and extra fields", () => {
    const { credential: _drop, ...noCredential } = valid;
    expect(SetupCompleteRequest.safeParse(noCredential).success).toBe(false);
    expect(SetupCompleteRequest.safeParse({ ...valid, type: "sftpgo" }).success).toBe(false);
    expect(SetupCompleteRequest.safeParse({ ...valid, baseUrl: "nope" }).success).toBe(false);
    expect(SetupCompleteRequest.safeParse({ ...valid, homeTemplate: "x" }).success).toBe(false);
  });

  it("rejects a body without a kind", () => {
    const { kind: _drop, ...rest } = valid;
    expect(SetupCompleteRequest.safeParse(rest).success).toBe(false);
  });
});
