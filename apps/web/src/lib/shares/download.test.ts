import { expect, it } from "vitest";
import { downloadFrameError } from "./download";

it("reads only bounded known same-origin API JSON, never returned document markup", () => {
  const input = {
    href: "http://localhost/api/v1/public-shares/id/download?path=%2F",
    expected: "http://localhost/api/v1/public-shares/id/download?path=%2F",
    contentType: "application/json; charset=utf-8",
    text: JSON.stringify({ error: { kind: "forbidden", message: "Wrong\npassword" } }),
  };
  expect(downloadFrameError(input)).toBe("Wrong password");
  for (const patch of [
    { href: "https://evil.test" },
    { contentType: "text/html" },
    { text: "x".repeat(8193) },
    { text: "{}" },
    { text: "bad" },
  ])
    expect(downloadFrameError({ ...input, ...patch })).toBeNull();
  expect(
    downloadFrameError({
      ...input,
      text: JSON.stringify({ error: { kind: "forbidden", message: "x".repeat(3000) } }),
    }),
  ).toHaveLength(2048);
});
