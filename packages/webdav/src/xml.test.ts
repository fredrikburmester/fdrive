import { describe, expect, it } from "vitest";
import { PROPFIND_BODY, parseMultistatus, parseStatusLine } from "./xml.js";

const PREFIXED = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/docs/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</D:getlastmodified>
        <D:getetag>"d1"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs/a%20%26%20b.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>5</D:getcontentlength>
        <D:getcontenttype>text/plain; charset=utf-8</D:getcontenttype>
        <D:getlastmodified>bogus</D:getlastmodified>
        <D:getetag>"f1"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><D:quota-used-bytes/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const DEFAULT_NS = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>http://host/dav/x</href>
    <propstat>
      <prop>
        <resourcetype/>
        <getcontentlength xmlns:b="urn:uuid:c2f41010-65b3-11d1-a29f-00aa00c14882/" b:dt="int">42</getcontentlength>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

describe("PROPFIND_BODY", () => {
  it("asks for the five live properties in the DAV: namespace", () => {
    expect(PROPFIND_BODY).toContain('xmlns:D="DAV:"');
    for (const prop of [
      "resourcetype",
      "getcontentlength",
      "getlastmodified",
      "getcontenttype",
      "getetag",
    ]) {
      expect(PROPFIND_BODY).toContain(`<D:${prop}/>`);
    }
  });
});

describe("parseStatusLine", () => {
  it("extracts the code from HTTP status lines", () => {
    expect(parseStatusLine("HTTP/1.1 200 OK")).toBe(200);
    expect(parseStatusLine(" HTTP/1.0 404 Not Found")).toBe(404);
    expect(parseStatusLine("HTTP/2 207")).toBe(207);
    expect(parseStatusLine({ "#text": "HTTP/1.1 403 Forbidden", "@_x": "y" })).toBe(403);
    expect(parseStatusLine("200")).toBeNull();
    expect(parseStatusLine(undefined)).toBeNull();
    expect(parseStatusLine({})).toBeNull();
  });
});

describe("parseMultistatus", () => {
  it("parses prefixed responses, keeping encoded hrefs and only 2xx propstats", () => {
    const [dir, file] = parseMultistatus(PREFIXED, 100);
    expect(dir).toEqual({
      href: "/dav/docs/",
      status: null,
      props: {
        collection: true,
        contentLength: null,
        lastModified: new Date("2015-10-21T07:28:00Z"),
        contentType: null,
        etag: '"d1"',
      },
    });
    expect(file).toEqual({
      href: "/dav/docs/a%20%26%20b.txt",
      status: null,
      props: {
        collection: false,
        contentLength: 5,
        lastModified: null,
        contentType: "text/plain; charset=utf-8",
        etag: '"f1"',
      },
    });
  });

  it("parses a default namespace and attribute-decorated values", () => {
    const [entry] = parseMultistatus(DEFAULT_NS, 100);
    expect(entry?.href).toBe("http://host/dav/x");
    expect(entry?.props.collection).toBe(false);
    expect(entry?.props.contentLength).toBe(42);
  });

  it("parses lowercase prefixes and a response-level status", () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/gone</d:href>
      <d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`;
    expect(parseMultistatus(xml, 100)).toEqual([
      {
        href: "/gone",
        status: 404,
        props: {
          collection: false,
          contentLength: null,
          lastModified: null,
          contentType: null,
          etag: null,
        },
      },
    ]);
  });

  it("returns no responses for an empty multistatus or one without responses", () => {
    expect(parseMultistatus('<D:multistatus xmlns:D="DAV:"/>', 100)).toEqual([]);
    expect(parseMultistatus('<D:multistatus xmlns:D="DAV:"><D:x/></D:multistatus>', 100)).toEqual(
      [],
    );
  });

  it("rejects a multistatus that is not an element", () => {
    expect(() => parseMultistatus("<multistatus>text</multistatus>", 100)).toThrow(/malformed/);
  });

  it("ignores propstats and props that are not elements, and non-numeric lengths", () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/x</D:href>
      <D:propstat>text</D:propstat>
      <D:propstat><D:prop>text</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
      <D:propstat><D:prop><D:getcontentlength>abc</D:getcontentlength><D:getcontenttype> </D:getcontenttype><D:getlastmodified/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
      <D:propstat><D:prop><D:getcontentlength>7</D:getcontentlength></D:prop><D:status>garbage</D:status></D:propstat>
      </D:response></D:multistatus>`;
    const [entry] = parseMultistatus(xml, 100);
    expect(entry?.props).toEqual({
      collection: false,
      contentLength: null,
      lastModified: null,
      contentType: null,
      etag: null,
    });
  });

  it("rejects a body without a multistatus element, a response without href, or a non-element response", () => {
    expect(() => parseMultistatus("<html/>", 100)).toThrow(/malformed/);
    expect(() => parseMultistatus("plain text", 100)).toThrow(/malformed/);
    expect(() =>
      parseMultistatus('<D:multistatus xmlns:D="DAV:"><D:response/></D:multistatus>', 100),
    ).toThrow(/malformed/);
    expect(() =>
      parseMultistatus(
        '<D:multistatus xmlns:D="DAV:"><D:response>x</D:response></D:multistatus>',
        100,
      ),
    ).toThrow(/malformed/);
  });

  it("rejects unparsable XML", () => {
    expect(() => parseMultistatus('<D:multistatus xmlns:D="DAV:"><!-- ', 100)).toThrow(/malformed/);
    expect(() => parseMultistatus("<D:multistatus", 100)).toThrow(/malformed/);
  });

  it("refuses more entries than allowed", () => {
    const xml = `<D:multistatus xmlns:D="DAV:">${"<D:response><D:href>/a</D:href></D:response>".repeat(3)}</D:multistatus>`;
    expect(() => parseMultistatus(xml, 2)).toThrow(/too many entries/);
    expect(parseMultistatus(xml, 3)).toHaveLength(3);
  });
});
