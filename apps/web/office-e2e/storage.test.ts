import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { run } from "./process";
import { fixtureState, type OfficeFixtureState } from "./state";
import {
  putOverSftp,
  storageToken,
  storedBytes,
  storedMetadata,
  storedText,
  storedXml,
} from "./storage";

it("reads only the configured private fixture state", async () => {
  await expect(fixtureState("")).rejects.toThrow("not started");
  const directory = await mkdtemp(join(tmpdir(), "office-state-unit-"));
  try {
    await writeFile(join(directory, "office.json"), JSON.stringify({ product: "onlyoffice" }));
    expect(await fixtureState(directory)).toEqual({ product: "onlyoffice" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("logs in and downloads the literal storage path without printing credentials", async () => {
  const state = { sftpgoUrl: "http://fixture.test" } as OfficeFixtureState;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return String(input).endsWith("/token")
      ? Response.json({ access_token: "fixture-token" })
      : new Response("saved");
  };
  expect(await storageToken(state, fetcher)).toBe("fixture-token");
  expect(Buffer.from(await storedBytes(state, "/Å %20.docx", fetcher)).toString()).toBe("saved");
  expect(calls.at(-1)).toBe("http://fixture.test/api/v2/user/files?path=%2F%C3%85%20%2520.docx");
  await expect(
    storageToken(state, async () => new Response(null, { status: 403 })),
  ).rejects.toThrow("403");
  await expect(
    storedBytes(state, "/x", async (input) =>
      String(input).endsWith("/token")
        ? Response.json({ access_token: "fixture" })
        : new Response(null, { status: 404 }),
    ),
  ).rejects.toThrow("404");
});
it("extracts real OOXML and tolerates the initial empty document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "office-zip-unit-"));
  const state = { directory, sftpgoUrl: "http://fixture.test" } as OfficeFixtureState;
  const fetcher =
    (bytes: Uint8Array): typeof fetch =>
    async (input) =>
      String(input).endsWith("/token")
        ? Response.json({ access_token: "fixture" })
        : new Response(Buffer.from(bytes));
  try {
    expect(await storedXml(state, "/empty.docx", fetcher(new Uint8Array()))).toBe("");
    const file = join(directory, "source.zip");
    await run("python3", [
      "-c",
      "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('word/document.xml','<p>saved text<span> &amp; more</span></p>')\n z.writestr('binary.bin',b'\\xff')",
      file,
    ]);
    expect(await storedXml(state, "/x.docx", fetcher(await readFile(file)))).toContain(
      "<p>saved text<span> &amp; more</span></p>",
    );
    expect(await storedText(state, "/x.docx", fetcher(await readFile(file)))).toBe(
      "saved text & more\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("uses an actual SFTP batch upload with preserved timestamps", async () => {
  const execute = vi.fn<typeof import("./process").runWithInput>().mockResolvedValue();
  const state = {
    directory: "/tmp/fixture",
    sftpgoContainer: "123456abcdef",
  } as OfficeFixtureState;
  await putOverSftp(state, "/tmp/a b", "/Å %20.docx", execute);
  expect(execute.mock.calls[0]?.[0]).toBe("sftp");
  expect(execute.mock.calls[0]?.[2]).toBe('put -p "/tmp/a b" "/Å %20.docx"\n');
});

it("reads remote size and last-modified with a real HEAD contract", async () => {
  const state = { sftpgoUrl: "http://fixture.test" } as OfficeFixtureState;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/token")) return Response.json({ access_token: "fixture" });
    expect(init?.method).toBe("HEAD");
    return new Response(null, {
      headers: { "content-length": "12", "last-modified": "Tue, 14 Nov 2023 22:13:20 GMT" },
    });
  };
  expect(await storedMetadata(state, "/x", fetcher)).toEqual({
    size: 12,
    modified: "Tue, 14 Nov 2023 22:13:20 GMT",
  });
  for (const response of [
    new Response(null, { status: 404 }),
    new Response(null),
    new Response(null, { headers: { "content-length": "1" } }),
  ]) {
    await expect(
      storedMetadata(state, "/x", async (input) =>
        String(input).endsWith("/token") ? Response.json({ access_token: "fixture" }) : response,
      ),
    ).rejects.toThrow("metadata unavailable");
  }
});
