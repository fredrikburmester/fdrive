import { expect, it, vi } from "vitest";
import { createSftpgoClient } from "./client.ts";
import { createFakeSftpgoServer } from "./fake/server.ts";

it("downloads original single files with ranges and keeps directory lists quota-free", async () => {
  const server = createFakeSftpgoServer({
    users: [{ username: "a", password: "p", permissions: { "/": ["*"] } }],
    files: { a: { "/f.txt": "content", "/dir/a.txt": "a" } },
  });
  const client = createSftpgoClient({ baseUrl: "http://test", fetch: server.fetch });
  const user = client.user((await client.login({ username: "a", password: "p" })).accessToken);
  const { id } = await user.shares.create({
    name: "f",
    scope: "read",
    paths: ["/f.txt"],
    password: "secret",
  });
  const pub = client.publicShare(id, "secret");
  expect(await new Response((await pub.downloadFile()).body).text()).toBe("content");
  expect(
    await new Response(
      (await pub.downloadFile({ rangeHeader: "bytes=-3", ifRange: new Date(0).toUTCString() }))
        .body,
    ).text(),
  ).toBe("ent");
  expect(
    await new Response((await pub.downloadFile({ range: { start: 1, end: 2 } })).body).text(),
  ).toBe("on");
  await expect(client.publicShare(id).downloadFile()).rejects.toMatchObject({
    kind: "unauthorized",
  });
  for (const method of [
    () => pub.downloadFile({ rangeHeader: "bad" }),
    () => pub.download("/a", { rangeHeader: "bytes=0-1,3-4" }),
  ])
    await expect(method()).rejects.toMatchObject({ kind: "bad_request" });
  const dir = await user.shares.create({ name: "d", scope: "read", paths: ["/dir"], maxTokens: 1 });
  await client.publicShare(dir.id).list();
  await client.publicShare(dir.id).list();
  expect((await user.shares.get(dir.id)).usedTokens).toBe(0);
  expect((await client.publicShare(dir.id).downloadFile()).contentType).toBe("application/zip");
  const write = await user.shares.create({ name: "w", scope: "write", paths: ["/dir"] });
  await expect(client.publicShare(write.id).zip()).rejects.toMatchObject({ kind: "forbidden" });
});
it("preserves download response metadata, empty streams and abort signals", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 200 }));
  const pub = createSftpgoClient({ baseUrl: "http://test", fetch }).publicShare("id");
  expect((await pub.downloadFile()).contentLength).toBeNull();
  await pub.zip({ signal });
  await pub.upload("a", new Uint8Array(), { signal });
  controller.abort();
  expect(fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  await pub.download("/a", { rangeHeader: "bytes=1-" });
  expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("range")).toBe("bytes=1-");
});
