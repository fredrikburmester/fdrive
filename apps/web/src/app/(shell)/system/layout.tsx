import type { Route } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loadMe } from "../load-me";

/**
 * `/files` is served by an optional catch-all route, which Next's typed
 * routes only model as `/files/${string}`; the same escape hatch
 * `lib/api/auth-queries` uses.
 */
const FILES_ROUTE = "/files" as unknown as Route;

/**
 * Gate for every `System` page. The sidebar only hides the section from
 * non-administrators; this layout is what actually refuses them. The API
 * already answers 403 on the admin routes, so nothing is exposed either
 * way, but the page shell must not render for an account the section is
 * not meant for: a signed-in non-admin who types `/system/storage` is sent
 * to `/files`. A missing or expired session is handled by `loadMe` itself.
 */
export default async function SystemLayout({ children }: { children: ReactNode }) {
  const me = await loadMe();
  if (!me.isAdmin) {
    redirect(FILES_ROUTE);
  }
  return <>{children}</>;
}
