import type { SettingsRepo } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiHttpError } from "../errors.js";
import { CONNECTION_SETTINGS_KEY, createConnectionStore } from "./store.js";

function buildSettings(): SettingsRepo {
  return createMemoryRepos().settings;
}

function buildClock(startMs: number) {
  let now = startMs;
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createConnectionStore: current", () => {
  let clockCtl: ReturnType<typeof buildClock>;

  beforeEach(() => {
    clockCtl = buildClock(1_700_000_000_000);
  });

  it("uses the real clock when none is supplied", async () => {
    const store = createConnectionStore({
      settings: buildSettings(),
      envUrl: "http://sftpgo:8080",
      defaultHomeTemplate: "sftpgo:/{username}",
    });

    expect(await store.current()).toEqual({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      source: "env",
    });
  });

  it("returns the env connection when SFTPGO_URL is set", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: "http://sftpgo:8080",
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    expect(await store.current()).toEqual({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/{username}",
      source: "env",
    });
  });

  it("returns null when there is no env URL and nothing is stored", async () => {
    const store = createConnectionStore({
      settings: buildSettings(),
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    expect(await store.current()).toBeNull();
  });

  it("returns null when the env URL is an empty string", async () => {
    const store = createConnectionStore({
      settings: buildSettings(),
      envUrl: "",
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    expect(await store.current()).toBeNull();
  });

  it("returns the settings-stored connection when there is no env URL", async () => {
    const settings = buildSettings();
    await settings.set(CONNECTION_SETTINGS_KEY, {
      baseUrl: "http://stored:8080",
      homeTemplate: "sftpgo:/home/{username}",
    });
    const store = createConnectionStore({
      settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    expect(await store.current()).toEqual({
      baseUrl: "http://stored:8080",
      homeTemplate: "sftpgo:/home/{username}",
      source: "settings",
    });
  });

  it("falls back to the default home template when settings has none", async () => {
    const settings = buildSettings();
    await settings.set(CONNECTION_SETTINGS_KEY, { baseUrl: "http://stored:8080" });
    const store = createConnectionStore({
      settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    expect(await store.current()).toEqual({
      baseUrl: "http://stored:8080",
      homeTemplate: "sftpgo:/{username}",
      source: "settings",
    });
  });

  it("uses a settings-stored homeTemplate override even when the source is env", async () => {
    const settings = buildSettings();
    await settings.set(CONNECTION_SETTINGS_KEY, { homeTemplate: "sftpgo:/override/{username}" });
    const store = createConnectionStore({
      settings,
      envUrl: "http://sftpgo:8080",
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    expect(await store.current()).toEqual({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/override/{username}",
      source: "env",
    });
  });

  it("caches the resolved connection for the ttl, then re-resolves", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    expect(await store.current()).toBeNull();

    await settings.set(CONNECTION_SETTINGS_KEY, { baseUrl: "http://stored:8080" });
    // Still within the cache window: the stale null is returned.
    expect(await store.current()).toBeNull();

    clockCtl.advance(5001);
    expect(await store.current()).toEqual({
      baseUrl: "http://stored:8080",
      homeTemplate: "sftpgo:/{username}",
      source: "settings",
    });
  });
});

describe("createConnectionStore: update", () => {
  let clockCtl: ReturnType<typeof buildClock>;

  beforeEach(() => {
    clockCtl = buildClock(1_700_000_000_000);
  });

  it("creates a connection from nothing when both fields are given", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    const result = await store.update({
      baseUrl: "http://new:8080",
      homeTemplate: "sftpgo:/home/{username}",
    });

    expect(result).toEqual({
      baseUrl: "http://new:8080",
      homeTemplate: "sftpgo:/home/{username}",
      source: "settings",
    });
    expect(await store.current()).toEqual(result);
  });

  it("throws bad_request when creating from nothing without a baseUrl", async () => {
    const store = createConnectionStore({
      settings: buildSettings(),
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    await expect(store.update({ homeTemplate: "sftpgo:/{username}" })).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("updates only the home template, keeping the previously stored baseUrl", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });
    await store.update({ baseUrl: "http://stored:8080", homeTemplate: "sftpgo:/{username}" });

    const result = await store.update({ homeTemplate: "sftpgo:/new/{username}" });

    expect(result).toEqual({
      baseUrl: "http://stored:8080",
      homeTemplate: "sftpgo:/new/{username}",
      source: "settings",
    });
  });

  it("updates the settings baseUrl when the source is already settings", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });
    await store.update({ baseUrl: "http://first:8080" });

    const result = await store.update({ baseUrl: "http://second:8080" });

    expect(result.baseUrl).toBe("http://second:8080");
  });

  it("refuses to change baseUrl when the source is env", async () => {
    const store = createConnectionStore({
      settings: buildSettings(),
      envUrl: "http://sftpgo:8080",
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    await expect(store.update({ baseUrl: "http://other:8080" })).rejects.toBeInstanceOf(
      ApiHttpError,
    );
  });

  it("allows updating the home template while the source is env", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: "http://sftpgo:8080",
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });

    const result = await store.update({ homeTemplate: "sftpgo:/env-override/{username}" });

    expect(result).toEqual({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/env-override/{username}",
      source: "env",
    });
  });

  it("keeps a previously stored home template override when patch has none, source env", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: "http://sftpgo:8080",
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });
    await store.update({ homeTemplate: "sftpgo:/first/{username}" });

    const result = await store.update({});

    expect(result).toEqual({
      baseUrl: "http://sftpgo:8080",
      homeTemplate: "sftpgo:/first/{username}",
      source: "env",
    });
  });

  it("re-fills the cache with the updated value", async () => {
    const settings = buildSettings();
    const store = createConnectionStore({
      settings,
      envUrl: undefined,
      defaultHomeTemplate: "sftpgo:/{username}",
      clock: clockCtl.clock,
    });
    await store.current();

    await store.update({ baseUrl: "http://updated:8080" });

    expect(await store.current()).toEqual({
      baseUrl: "http://updated:8080",
      homeTemplate: "sftpgo:/{username}",
      source: "settings",
    });
  });
});
