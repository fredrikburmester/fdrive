import type { MeResponse } from "@fdrive/contracts";
import { pathToHref, viewHref } from "@/lib/files/path-url";
import { revealHref } from "@/lib/search/reveal";

export type AccountIdentity = MeResponse["identities"][number];

export function identityLabel(identities: readonly AccountIdentity[], id: string): string {
  const identity = identities.find((item) => item.id === id);
  return identity ? `${identity.username} · ${identity.providerLabel}` : "Unavailable login";
}

export function accountItemKey(identityId: string, path: string): string {
  return JSON.stringify([identityId, path]);
}

export function accountItemHref(kind: "file" | "dir" | "reveal", path: string): string {
  return kind === "reveal" ? revealHref(path) : kind === "dir" ? pathToHref(path) : viewHref(path);
}

/** Never navigate to a path until its owning identity is active. */
export async function navigateAccountItem(
  me: MeResponse,
  identityId: string,
  href: string,
  switchIdentity: (identityId: string, href: string) => Promise<unknown>,
  navigate: (href: string) => void,
): Promise<void> {
  if (!me.identities.some((identity) => identity.id === identityId)) {
    throw new Error("That login is no longer linked to this account.");
  }
  if (identityId !== me.activeIdentityId) {
    await switchIdentity(identityId, href);
  } else {
    navigate(href);
  }
}
