import { describe, expect, it } from "vitest";
import { parseStoredCredential } from "./stored-credential.ts";

const encode = (value: string) => new TextEncoder().encode(value);

describe("parseStoredCredential", () => {
  it("keeps the string fields of a stored object", () => {
    expect(parseStoredCredential(encode('{"username":"alice","password":"pw"}'))).toEqual({
      username: "alice",
      password: "pw",
    });
  });

  it("tolerates malformed stored blobs", () => {
    expect(parseStoredCredential(encode("not json"))).toEqual({});
    expect(parseStoredCredential(encode("[1]"))).toEqual({});
    expect(parseStoredCredential(encode("null"))).toEqual({});
    expect(parseStoredCredential(encode('{"a":"b","n":1}'))).toEqual({ a: "b" });
  });
});
