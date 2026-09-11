import { XMLParser } from "fast-xml-parser";
import { WebdavError } from "./errors.js";

/** The body of every `PROPFIND` fdrive sends: the five live properties it reads. */
export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  "<D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getcontenttype/><D:getetag/>" +
  "</D:prop></D:propfind>";

/** The properties of one resource, from the 2xx `propstat` blocks of its `response`. */
export interface MultistatusProps {
  readonly collection: boolean;
  readonly contentLength: number | null;
  readonly lastModified: Date | null;
  readonly contentType: string | null;
  readonly etag: string | null;
}

/** One `response` element of a `multistatus` body, hrefs still unresolved. */
export interface MultistatusResponse {
  readonly href: string;
  /** The response-level status (a 404 for a missing member), `null` when propstats carry it. */
  readonly status: number | null;
  readonly props: MultistatusProps;
}

const EMPTY_PROPS: MultistatusProps = {
  collection: false,
  contentLength: null,
  lastModified: null,
  contentType: null,
  etag: null,
};

const ARRAY_TAGS = new Set(["response", "propstat"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The text of a parsed element: a bare string, or the `#text` of an element
 * that also carried attributes (IIS decorates values with `b:dt="int"`).
 */
function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["#text"] === "string") return value["#text"];
  return null;
}

function malformed(detail: string): WebdavError {
  return new WebdavError("WebDAV multistatus body is malformed", "unexpected", null, detail);
}

/** The status code of an `HTTP/1.1 200 OK` status line, `null` when unparsable. */
export function parseStatusLine(value: unknown): number | null {
  const text = textOf(value);
  if (text === null) return null;
  const match = /^\s*HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function parseContentLength(value: unknown): number | null {
  const text = textOf(value);
  if (text === null || !/^\d+$/.test(text.trim())) return null;
  return Number(text.trim());
}

function parseDate(value: unknown): Date | null {
  const text = textOf(value);
  if (text === null || text.trim().length === 0) return null;
  const parsed = new Date(text.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseText(value: unknown): string | null {
  const text = textOf(value);
  return text === null || text.trim().length === 0 ? null : text.trim();
}

function isCollection(resourcetype: unknown): boolean {
  return isRecord(resourcetype) && "collection" in resourcetype;
}

function propsOf(prop: unknown, current: MultistatusProps): MultistatusProps {
  if (!isRecord(prop)) return current;
  return {
    collection: current.collection || isCollection(prop.resourcetype),
    contentLength: parseContentLength(prop.getcontentlength) ?? current.contentLength,
    lastModified: parseDate(prop.getlastmodified) ?? current.lastModified,
    contentType: parseText(prop.getcontenttype) ?? current.contentType,
    etag: parseText(prop.getetag) ?? current.etag,
  };
}

function responseOf(raw: unknown): MultistatusResponse {
  if (!isRecord(raw)) throw malformed("response is not an element");
  const href = textOf(raw.href);
  if (href === null) throw malformed("response without href");
  let props = EMPTY_PROPS;
  const propstats = Array.isArray(raw.propstat) ? raw.propstat : [];
  for (const propstat of propstats) {
    if (!isRecord(propstat)) continue;
    const status = parseStatusLine(propstat.status);
    if (status === null || status < 200 || status >= 300) continue;
    props = propsOf(propstat.prop, props);
  }
  return { href: href.trim(), status: parseStatusLine(raw.status), props };
}

/**
 * Parses a `multistatus` body into its responses. Namespace prefixes are
 * removed, so `D:response`, `d:response` and a default `xmlns="DAV:"` all
 * read the same. Throws `WebdavError("unexpected")` for a body that is not
 * a multistatus document or holds more than `maxEntries` responses; the
 * caller bounds the byte size before calling.
 */
export function parseMultistatus(xml: string, maxEntries: number): MultistatusResponse[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
    trimValues: true,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw malformed(String(error));
  }
  if (!isRecord(parsed) || !("multistatus" in parsed)) {
    throw malformed("no multistatus element");
  }
  const root = parsed.multistatus;
  if (root === "") return [];
  if (!isRecord(root)) throw malformed("multistatus is not an element");
  const raw = root.response;
  const responses = Array.isArray(raw) ? raw : [];
  if (responses.length > maxEntries) {
    throw new WebdavError(
      "WebDAV multistatus body has too many entries",
      "unexpected",
      null,
      `more than ${maxEntries} responses`,
    );
  }
  return responses.map(responseOf);
}
