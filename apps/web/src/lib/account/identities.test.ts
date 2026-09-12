import { describe, expect, it, vi } from "vitest";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";
import { accountItemHref, accountItemKey, identityLabel, navigateAccountItem } from "./identities";

const me = makeMe({
  identities: [
    makeIdentity(),
    makeIdentity({ id: "two", username: "bob", providerLabel: "Other" }),
  ],
  activeIdentityId: "one",
});

describe("account identity results", () => {
  it("labels unavailable identities and separates duplicate paths", () => {
    expect(identityLabel(me.identities, "one")).toBe("ada · Main");
    expect(identityLabel(me.identities, "missing")).toBe("Unavailable login");
    expect(accountItemKey("one", "/same")).not.toBe(accountItemKey("two", "/same"));
    expect(accountItemKey("a:/", "b")).not.toBe(accountItemKey("a", "/:b"));
  });
  it("encodes file, folder and reveal targets safely", () => {
    expect(accountItemHref("file", "/a #?.txt")).toBe("/view/a%20%23%3F.txt");
    expect(accountItemHref("dir", "/a b")).toBe("/files/a%20b");
    expect(accountItemHref("reveal", "/a b/file.txt")).toBe("/files/a%20b?select=file.txt");
  });
  it("navigates an active identity directly, switches before cross-login navigation", async () => {
    const navigate = vi.fn();
    const switchIdentity = vi.fn(async () => {});
    await navigateAccountItem(me, "one", "/view/f", switchIdentity, navigate);
    expect(navigate).toHaveBeenCalledWith("/view/f");
    navigate.mockClear();
    await navigateAccountItem(me, "two", "/view/f", switchIdentity, navigate);
    expect(switchIdentity).toHaveBeenCalledWith("two", "/view/f");
    expect(navigate).not.toHaveBeenCalled();
    switchIdentity.mockRejectedValueOnce(new Error("denied"));
    await expect(
      navigateAccountItem(me, "two", "/view/f", switchIdentity, navigate),
    ).rejects.toThrow("denied");
    await expect(
      navigateAccountItem(me, "missing", "/view/f", switchIdentity, navigate),
    ).rejects.toThrow("no longer linked");
    expect(navigate).not.toHaveBeenCalled();
  });
});
