import { AccountIdentityId, ApiClientError } from "@fdrive/contracts";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { serverApiClient } from "@/lib/api/server";
import { DesktopConnect } from "./desktop-connect";

export default async function DesktopConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const parsed = AccountIdentityId.safeParse((await searchParams).request);
  if (!parsed.success)
    return <main className="p-6">Start a connection from the fdrive Mac app.</main>;
  const client = await serverApiClient();
  try {
    const me = await client.me();
    return <DesktopConnect requestId={parsed.data} initialMe={me} />;
  } catch (error) {
    if (error instanceof ApiClientError && error.kind === "unauthorized") {
      redirect(`/login?desktopRequest=${parsed.data}` as Route);
    }
    throw error;
  }
}
