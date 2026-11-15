import { expect, it, vi } from "vitest";
import { createApiClient } from "./client.ts";
import { DesktopPairApproval, DesktopPath } from "./desktop.ts";

it("keeps desktop paths absolute and rejects control characters", () => {
  for (const path of ["/", "/hello/å%20.txt"]) expect(DesktopPath.parse(path)).toBe(path);
  for (const path of ["relative", "/bad\u0000name", "/bad\u007fname"])
    expect(DesktopPath.safeParse(path).success).toBe(false);
  expect(DesktopPairApproval.safeParse({}).success).toBe(false);
  expect(DesktopPairApproval.safeParse({ access: "admin" }).success).toBe(false);
  expect(DesktopPairApproval.safeParse({ access: "read", identityIds: [] }).success).toBe(false);
});

it("reads connection info and approves with the chosen access and CSRF protection", async () => {
  const info = {
    deviceName: "Mac",
    code: "1234ABCD",
    expiresAt: "2026-09-13T16:00:00.000Z",
    approved: false,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json(init?.method === "POST" ? { ok: true } : info),
  );
  const client = createApiClient({ fetch });
  expect(await client.desktopPairing("request/id")).toEqual(info);
  await client.approveDesktopPairing("request/id", "full");
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "/api/v1/desktop/pairings/request%2Fid",
    "/api/v1/desktop/pairings/request%2Fid/approve",
  ]);
  const options = fetch.mock.calls[1]?.[1];
  expect(new Headers(options?.headers).get("x-requested-with")).toBe("fdrive");
  expect(JSON.parse(String(options?.body))).toEqual({ access: "full" });
});
