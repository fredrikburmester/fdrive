import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiHttpError } from "../errors.js";
import { createActivityCursors } from "./cursor.js";

const SECRET = "secret";
/** Signs an arbitrary payload the way the module does, to test what a valid
 * signature over a bad body is rejected on. */
function forge(value: unknown) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  const mac = createHmac("sha256", SECRET).update(`activity:v1:${body}`).digest("base64url");
  return `${body}.${mac}`;
}

describe("activity cursors", () => {
  const cursors = createActivityCursors(SECRET);
  const owner = randomUUID();

  it("round-trips a position for its own owner and query", () => {
    const cursor = cursors.encode(owner, "feed", "position");

    expect(cursors.decode(owner, "feed", cursor)).toBe("position");
  });

  it("refuses a cursor from another owner, another query or another secret", () => {
    const cursor = cursors.encode(owner, "feed", "position");

    expect(() => cursors.decode(randomUUID(), "feed", cursor)).toThrow(ApiHttpError);
    expect(() => cursors.decode(owner, "other", cursor)).toThrow(ApiHttpError);
    expect(() =>
      cursors.decode(owner, "feed", createActivityCursors("other").encode(owner, "feed", "p")),
    ).toThrow(ApiHttpError);
  });

  it("refuses anything that is not one signed body", () => {
    const [body, mac] = cursors.encode(owner, "feed", "position").split(".");

    for (const cursor of [
      "",
      "nodot",
      `.${mac}`,
      `${body}.`,
      `${body}.${mac}.extra`,
      `${body}.${Buffer.from("short").toString("base64url")}`,
    ])
      expect(() => cursors.decode(owner, "feed", cursor)).toThrow(ApiHttpError);
  });

  it("refuses a correctly signed body that is not a three-part position", () => {
    for (const value of [
      "plain",
      [owner, "feed"],
      [owner, "feed", "p", "extra"],
      [owner, "feed", 1],
    ])
      expect(() => cursors.decode(owner, "feed", forge(value))).toThrow(ApiHttpError);

    expect(cursors.decode(owner, "feed", forge([owner, "feed", "p"]))).toBe("p");
  });
});
