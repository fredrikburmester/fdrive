"use client";

import {
  ChevronsUpDown,
  Clock3,
  HardDrive,
  Images,
  Info,
  Link2,
  LogOut,
  Monitor,
  Moon,
  PanelLeftIcon,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { FavoritesSection } from "@/components/shell/favorites-section";
import { FolderTree } from "@/components/shell/folder-tree";
import { useShellMe } from "@/components/shell/page-header";
import { RecentsSection } from "@/components/shell/recents-section";
import { SidebarResizeHandle } from "@/components/shell/resizable-sidebar";
import { SavedSearchesSection } from "@/components/shell/saved-searches-section";
import { SharedWithMeItem } from "@/components/shell/shared-with-me-item";
import { SIDEBAR_ROW, SidebarSectionLabel } from "@/components/shell/sidebar-section";
import { SystemNav } from "@/components/shell/system-nav";
import { TagsSection } from "@/components/shell/tags-section";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useLogout } from "@/lib/api/auth-queries";
import { useSidebarSwipe } from "@/lib/sidebar-swipe";
import { SYSTEM_SCOPE_CAPTION } from "@/lib/system/pages";

const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/** First two letters of a login's title, upper-cased, for the avatar fallback. */
export function avatarInitials(title: string): string {
  return title.slice(0, 2).toUpperCase();
}

/** True when `pathname` is the Files location or a path within it. */
export function isFilesRoute(pathname: string | null): boolean {
  return pathname === "/files" || (pathname?.startsWith("/files/") ?? false);
}

/** True when `pathname` is the System location or a path within it. */
export function isSystemRoute(pathname: string | null): boolean {
  return pathname === "/system" || (pathname?.startsWith("/system/") ?? false);
}

/** True when `pathname` is the Trash location. */
export function isTrashRoute(pathname: string | null): boolean {
  return pathname === "/trash";
}

// `/files` is served by an optional catch-all route, which Next's typed
// routes only model as `/files/${string}`, not the bare path.
const FILES_ROUTE = "/files" as unknown as Route;
const TRASH_ROUTE = "/trash" as Route;
// Settings keeps the `/account` URL it had while it was called Account.
const SETTINGS_ROUTE = "/account" as Route;
const STORAGE_ROUTE = "/storage" as Route;

export function AppSidebar() {
  const { data: me } = useShellMe();
  const { theme, setTheme } = useTheme();
  const logout = useLogout();
  const pathname = usePathname();
  const { isMobile, openMobile, setOpenMobile, toggleSidebar } = useSidebar();
  useSidebarSwipe(isMobile, openMobile, setOpenMobile);

  const username = me?.identity.username;

  return (
    <Sidebar className="border-sidebar-border">
      {/* As tall as the page header beside it, so the two line up. */}
      <SidebarHeader className="h-12 flex-row items-center gap-1.5 px-3 py-0">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close sidebar"
          className="rounded-sm text-sidebar-foreground/70"
          onClick={toggleSidebar}
        >
          <PanelLeftIcon />
        </Button>
        {/* The wordmark returns to the root of Files, like a site logo. */}
        <Link
          href={FILES_ROUTE}
          className="rounded-sm text-[24px] leading-none font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          fdrive
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-4 pt-1 pb-3">
        <SidebarGroup className="py-0">
          <SidebarSectionLabel>Locations</SidebarSectionLabel>
          <SidebarMenu className="mt-0.5">
            <FolderTree />
            <SharedWithMeItem />
          </SidebarMenu>
        </SidebarGroup>
        <FavoritesSection />
        <SidebarGroup className="py-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={SIDEBAR_ROW}
                isActive={pathname === "/photos"}
                render={<Link href={"/photos" as Route} />}
              >
                <Images />
                <span>Photos</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={SIDEBAR_ROW}
                isActive={pathname?.startsWith("/activity")}
                render={<Link href={"/activity" as Route} />}
              >
                <Clock3 />
                <span>My activity</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <TagsSection />
        <SavedSearchesSection />
        <RecentsSection />
        {/* Shares and Trash sit at the bottom of the navigation, above System. */}
        <SidebarGroup className="py-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={SIDEBAR_ROW}
                isActive={pathname === "/shares"}
                render={<Link href={"/shares" as Route} />}
              >
                <Link2 />
                <span>Shares</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={SIDEBAR_ROW}
                isActive={isTrashRoute(pathname)}
                render={<Link href={TRASH_ROUTE} />}
              >
                <Trash2 />
                <span>Trash</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {me?.isAdmin ? (
          <SidebarGroup className="py-0">
            <SidebarSectionLabel>
              System
              <span className="ml-auto truncate font-normal text-sidebar-foreground/50">
                {SYSTEM_SCOPE_CAPTION}
              </span>
            </SidebarSectionLabel>
            <div className="mt-0.5">
              <SystemNav />
            </div>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg">
                <Avatar className="size-6">
                  <AvatarFallback>{username ? avatarInitials(username) : "?"}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                  <span className="truncate text-sm font-medium">{username ?? "..."}</span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    {me && <HardDrive aria-hidden className="size-3.5 shrink-0" />}
                    <span className="truncate">{me?.storageName ?? ""}</span>
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{username ?? "Account"}</DropdownMenuLabel>
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
              <DropdownMenuItem render={<Link href={SETTINGS_ROUTE} />}>
                <Settings />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href={STORAGE_ROUTE} />}>
                <HardDrive />
                Storage
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href={"/about" as Route} />}>
                <Info />
                About
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
      <SidebarResizeHandle />
    </Sidebar>
  );
}
