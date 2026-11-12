"use client";

import { UsersIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useShellMe } from "@/components/shell/page-header";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { pathToHref } from "@/lib/files/path-url";
import { SHARED_WITH_ME_PATH } from "@/lib/grants/paths";
import { useReceivedGrants } from "@/lib/grants/queries";
import { capabilitiesFor } from "@/lib/identity/capabilities";

const HREF = pathToHref(SHARED_WITH_ME_PATH);

/**
 * "Shared with me" under Locations: a shortcut to the folders other people
 * share with the active login, shown only while there are any.
 */
export function SharedWithMeItem() {
  const { data: me } = useShellMe();
  const received = useReceivedGrants(capabilitiesFor(me).shareWithPeople);
  const pathname = usePathname();
  if (received.length === 0) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={pathname === HREF || (pathname?.startsWith(`${HREF}/`) ?? false)}
        render={<Link href={HREF as Route} />}
      >
        <UsersIcon />
        <span>Shared with me</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
