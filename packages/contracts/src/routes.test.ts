import { describe, expect, it } from "vitest";
import {
  accountTokenRoute,
  IDENTITY_HEADER,
  jobCancelRoute,
  jobRoute,
  MODIFIED_AT_HEADER,
  ROUTES,
  tagFilesRoute,
  tagRoute,
} from "./routes";

describe("ROUTES", () => {
  it("defines every auth route under /api/v1/auth", () => {
    expect(ROUTES.auth).toEqual({
      login: "/api/v1/auth/login",
      logout: "/api/v1/auth/logout",
      me: "/api/v1/auth/me",
    });
  });

  it("defines every fs route under /api/v1/fs", () => {
    expect(ROUTES.fs).toEqual({
      list: "/api/v1/fs/list",
      stat: "/api/v1/fs/stat",
      download: "/api/v1/fs/download",
      zip: "/api/v1/fs/zip",
      upload: "/api/v1/fs/upload",
      mkdir: "/api/v1/fs/mkdir",
      move: "/api/v1/fs/move",
      copy: "/api/v1/fs/copy",
      rename: "/api/v1/fs/rename",
      delete: "/api/v1/fs/delete",
      duplicate: "/api/v1/fs/duplicate",
      compress: "/api/v1/fs/compress",
      extract: "/api/v1/fs/extract",
      jobs: "/api/v1/fs/jobs",
      tags: "/api/v1/fs/tags",
    });
  });

  it("defines the tags route", () => {
    expect(ROUTES.tags).toBe("/api/v1/tags");
  });

  it("defines the favorites route", () => {
    expect(ROUTES.favorites).toEqual({ base: "/api/v1/favorites" });
  });

  it("defines every recents route under /api/v1/recents", () => {
    expect(ROUTES.recents).toEqual({
      list: "/api/v1/recents",
      touch: "/api/v1/recents/touch",
    });
  });

  it("defines search routes under /api/v1/search", () => {
    expect(ROUTES.search).toEqual({
      query: "/api/v1/search",
      status: "/api/v1/search/status",
    });
  });

  it("defines the thumb route", () => {
    expect(ROUTES.thumb).toBe("/api/v1/thumb");
  });

  it("defines events and about routes", () => {
    expect(ROUTES.events).toBe("/api/v1/events");
    expect(ROUTES.about).toBe("/api/v1/about");
  });

  it("defines every setup route under /api/v1/setup", () => {
    expect(ROUTES.setup).toEqual({
      status: "/api/v1/setup/status",
      test: "/api/v1/setup/test",
      complete: "/api/v1/setup/complete",
    });
  });

  it("defines every admin route under /api/v1/admin", () => {
    expect(ROUTES.admin).toEqual({
      connection: "/api/v1/admin/connection",
      connectionUpdate: "/api/v1/admin/connection",
      connectionTest: "/api/v1/admin/connection/test",
    });
  });

  it("defines every system route under /api/v1/system", () => {
    expect(ROUTES.system).toEqual({
      indexer: "/api/v1/system/indexer",
      indexerSettings: "/api/v1/system/indexer/settings",
      indexerReindex: "/api/v1/system/indexer/reindex",
      indexerThumbnailsRebuild: "/api/v1/system/indexer/thumbnails/rebuild",
      search: "/api/v1/system/search",
      searchReembed: "/api/v1/system/search/reembed",
      ocr: "/api/v1/system/ocr",
      ocrSettings: "/api/v1/system/ocr/settings",
      ocrRun: "/api/v1/system/ocr/run",
      thumbnails: "/api/v1/system/thumbnails",
      thumbnailsRebuild: "/api/v1/system/thumbnails/rebuild",
    });
  });

  it("defines the account tokens route", () => {
    expect(ROUTES.account).toEqual({ tokens: "/api/v1/account/tokens" });
  });
});

describe("jobRoute", () => {
  it("builds the path for a single job", () => {
    expect(jobRoute("job-1")).toBe("/api/v1/fs/jobs/job-1");
  });

  it("url-encodes the id", () => {
    expect(jobRoute("a/b")).toBe("/api/v1/fs/jobs/a%2Fb");
  });
});

describe("jobCancelRoute", () => {
  it("builds the cancel path for a job", () => {
    expect(jobCancelRoute("job-1")).toBe("/api/v1/fs/jobs/job-1/cancel");
  });
});

describe("accountTokenRoute", () => {
  it("builds the path for a single token", () => {
    expect(accountTokenRoute("token-1")).toBe("/api/v1/account/tokens/token-1");
  });

  it("url-encodes the id", () => {
    expect(accountTokenRoute("a/b")).toBe("/api/v1/account/tokens/a%2Fb");
  });
});

describe("tagRoute", () => {
  it("builds the path for a single tag", () => {
    expect(tagRoute("tag-1")).toBe("/api/v1/tags/tag-1");
  });

  it("url-encodes the id", () => {
    expect(tagRoute("a/b")).toBe("/api/v1/tags/a%2Fb");
  });
});

describe("tagFilesRoute", () => {
  it("builds the files path for a single tag", () => {
    expect(tagFilesRoute("tag-1")).toBe("/api/v1/tags/tag-1/files");
  });
});

describe("headers", () => {
  it("IDENTITY_HEADER is x-identity-id", () => {
    expect(IDENTITY_HEADER).toBe("x-identity-id");
  });

  it("MODIFIED_AT_HEADER is x-modified-at", () => {
    expect(MODIFIED_AT_HEADER).toBe("x-modified-at");
  });
});
