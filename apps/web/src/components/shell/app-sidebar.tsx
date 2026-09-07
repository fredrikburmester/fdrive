"use client";

import {
  ChevronsUpDown,
  Database,
  Image,
  Link2,
  LogOut,
  Monitor,
  Moon,
  ScanText,
  Search,
  Settings2,
  Sun,
  UserRound,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { FavoritesSection } from "@/components/shell/favorites-section";
import { FolderTree } from "@/components/shell/folder-tree";
import { useShellMe } from "@/components/shell/page-header";
import { RecentsSection } from "@/components/shell/recents-section";
import { TagsSection } from "@/components/shell/tags-section";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useIdentityActions } from "@/lib/account/use-identities";
import { useLogout } from "@/lib/api/auth-queries";

const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/** First two letters of `username`, upper-cased, for the avatar fallback. */
export function avatarInitials(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

/** True when `pathname` is the Files location or a path within it. */
export function isFilesRoute(pathname: string | null): boolean {
  return pathname === "/files" || (pathname?.startsWith("/files/") ?? false);
}

/** True when `pathname` is the System location or a path within it. */
export function isSystemRoute(pathname: string | null): boolean {
  return pathname === "/system" || (pathname?.startsWith("/system/") ?? false);
}

const SYSTEM_CONNECTION_ROUTE = "/system/connection" as Route;
const SYSTEM_INDEXER_ROUTE = "/system/indexer" as Route;
const SYSTEM_SEARCH_ROUTE = "/system/search" as Route;
const SYSTEM_OCR_ROUTE = "/system/ocr" as Route;
const SYSTEM_THUMBNAILS_ROUTE = "/system/thumbnails" as Route;
const ACCOUNT_ROUTE = "/account" as Route;

const SYSTEM_NAV_ITEMS = [
  { href: SYSTEM_CONNECTION_ROUTE, label: "Connection", Icon: Settings2 },
  { href: SYSTEM_INDEXER_ROUTE, label: "Indexer", Icon: Database },
  { href: SYSTEM_SEARCH_ROUTE, label: "Search", Icon: Search },
  { href: SYSTEM_OCR_ROUTE, label: "OCR", Icon: ScanText },
  { href: SYSTEM_THUMBNAILS_ROUTE, label: "Thumbnails", Icon: Image },
] as const;

export function AppSidebar() {
  const { data: me } = useShellMe();
  const { theme, setTheme } = useTheme();
  const logout = useLogout();
  const identityActions = useIdentityActions();
  const pathname = usePathname();

  const activeIdentity = me?.identities.find((identity) => identity.id === me.activeIdentityId);

  return (
    <Sidebar className="border-r border-sidebar-border backdrop-blur-xl">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="text-base font-semibold tracking-tight">fdrive</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Locations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <FolderTree />
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/shares"}
                  render={<Link href={"/shares" as Route} />}
                >
                  <Link2 />
                  <span>Shares</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <FavoritesSection />
        <RecentsSection />
        <TagsSection />
        {me?.isAdmin ? (
          <SidebarGroup>
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {SYSTEM_NAV_ITEMS.map(({ href, label, Icon }) => (
                  <SidebarMenuButton
                    key={href}
                    isActive={pathname === href}
                    render={<Link href={href} />}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg">
                <Avatar className="size-6">
                  <AvatarFallback>
                    {activeIdentity ? avatarInitials(activeIdentity.username) : "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                  <span className="truncate text-sm font-medium">
                    {activeIdentity?.username ?? "..."}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {activeIdentity?.providerLabel ?? ""}
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Logins</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={me?.activeIdentityId ?? ""}
                onValueChange={(id) => {
                  if (id !== me?.activeIdentityId)
                    void identityActions
                      .switch(id)
                      .catch(() => toast.error("Could not switch login. Please try again."));
                }}
              >
                {me?.identities.map((identity) => (
                  <DropdownMenuRadioItem
                    key={identity.id}
                    value={identity.id}
                    disabled={identityActions.pending}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{identity.username}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {identity.providerLabel}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{activeIdentity?.username ?? "Account"}</DropdownMenuLabel>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Monitor />
                  Appearance
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={theme ?? "system"}
                    onValueChange={(value) => setTheme(value)}
                  >
                    {THEME_OPTIONS.map(({ value, label, Icon }) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        <Icon />
                        {label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href={ACCOUNT_ROUTE} />}>
                <UserRound />
                Account
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => logout.mutate()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
