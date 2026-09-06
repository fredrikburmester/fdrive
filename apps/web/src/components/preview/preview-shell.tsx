"use client";

import { parentPath } from "@fdrive/core";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Info, X } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Inspector } from "@/components/inspector/inspector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { apiClient, pathToHref, queryKeys, viewHref } from "@/lib/preview/deps";
import { previewKindFor } from "@/lib/preview/kind";
import { siblingNavigation } from "@/lib/preview/siblings";
import { PreviewViewer } from "./preview-viewer";

export interface PreviewShellProps {
  readonly path: string;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Asserts a dynamically built path is a valid Next.js route. Next's typed
 * routes can only verify string literals at compile time; paths built at
 * runtime (from `pathToHref`/`viewHref`) need this explicit (safe, since
 * they are always same-origin app paths) cast.
 */
function toRoute(href: string): Route {
  return href as Route;
}

interface TopBarActionProps {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly disabled?: boolean;
  readonly active?: boolean;
  /** An in-app route, navigated via `next/link`. */
  readonly route?: string | undefined;
  /** An external resource URL (download, open in new tab), rendered as a plain anchor. */
  readonly href?: string | undefined;
  readonly target?: string | undefined;
  readonly rel?: string | undefined;
  readonly download?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly children: ReactNode;
}

/**
 * One icon button in the top bar, wrapped in a tooltip. Renders as a
 * `next/link` when `route` is given (in-app navigation), a plain anchor
 * when `href` is given (an external resource: download, open in new tab),
 * or a plain button otherwise.
 */
function TopBarAction({
  label,
  shortcut,
  disabled = false,
  active = false,
  route,
  href,
  target,
  rel,
  download,
  onClick,
  children,
}: TopBarActionProps) {
  const renderAs =
    route !== undefined ? (
      <Link href={toRoute(route)} />
    ) : href !== undefined ? (
      // biome-ignore lint/a11y/useAnchorContent: Base UI's render-prop merge injects TooltipTrigger's icon/sr-only children into this anchor
      <a href={href} target={target} rel={rel} download={download} />
    ) : undefined;
  // Base UI's Button expects a real <button> unless told otherwise: only
  // set `nativeButton={false}` when it renders as a link or anchor instead.
  const isNativeButton = renderAs === undefined;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            disabled={disabled}
            onClick={onClick}
            nativeButton={isNativeButton}
            render={renderAs}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function PreviewShellContent({ path }: PreviewShellProps) {
  const router = useRouter();
  const [infoOpen, setInfoOpen] = useState(false);
  const parent = parentPath(path);

  const entryQuery = useQuery({
    queryKey: queryKeys.fs.stat(path),
    queryFn: () => apiClient.stat(path),
  });

  const listQuery = useQuery({
    queryKey: queryKeys.fs.list(parent),
    queryFn: () => apiClient.list(parent),
  });

  const siblings = siblingNavigation(listQuery.data?.entries ?? [], path);
  const backHref = pathToHref(parent);
  const prevHref = siblings.prev !== null ? viewHref(siblings.prev) : undefined;
  const nextHref = siblings.next !== null ? viewHref(siblings.next) : undefined;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        router.push(toRoute(backHref));
        return;
      }
      if (event.key === "ArrowLeft" && siblings.prev !== null) {
        router.push(toRoute(viewHref(siblings.prev)));
        return;
      }
      if (event.key === "ArrowRight" && siblings.next !== null) {
        router.push(toRoute(viewHref(siblings.next)));
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router, backHref, siblings.prev, siblings.next]);

  const entry = entryQuery.data;
  const downloadUrl = apiClient.downloadUrl(path);
  const inlineUrl = apiClient.downloadUrl(path, { inline: true });

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm supports-backdrop-filter:bg-background/60">
          <TopBarAction label="Back to folder" route={backHref}>
            <ChevronLeft />
            <span className="sr-only">Back</span>
          </TopBarAction>

          <Separator orientation="vertical" className="h-5" />

          <span className="min-w-0 truncate text-sm font-medium">{entry?.name ?? "Loading…"}</span>

          {entry !== undefined && (
            <Badge variant="secondary">{capitalize(previewKindFor(entry))}</Badge>
          )}

          <div className="flex flex-1 items-center justify-center gap-1">
            <TopBarAction
              label="Previous"
              shortcut="←"
              disabled={prevHref === undefined}
              route={prevHref}
            >
              <ChevronLeft />
              <span className="sr-only">Previous</span>
            </TopBarAction>
            {siblings.total > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {siblings.index + 1} / {siblings.total}
              </span>
            )}
            <TopBarAction
              label="Next"
              shortcut="→"
              disabled={nextHref === undefined}
              route={nextHref}
            >
              <ChevronRight />
              <span className="sr-only">Next</span>
            </TopBarAction>
          </div>

          <TopBarAction label="Download" href={downloadUrl} download={entry?.name ?? "download"}>
            <Download />
            <span className="sr-only">Download</span>
          </TopBarAction>

          <TopBarAction label="Open in new tab" href={inlineUrl} target="_blank" rel="noreferrer">
            <ExternalLink />
            <span className="sr-only">Open in new tab</span>
          </TopBarAction>

          <TopBarAction
            label="Info"
            shortcut="I"
            active={infoOpen}
            onClick={() => setInfoOpen((prev) => !prev)}
          >
            <Info />
            <span className="sr-only">Info</span>
          </TopBarAction>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {entryQuery.status === "pending" && (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
                <Skeleton className="h-48 w-full max-w-md" />
                <Skeleton className="h-4 w-40" />
              </div>
            )}
            {entryQuery.status === "error" && (
              <div className="flex h-full items-center justify-center p-8">
                <Card className="max-w-sm">
                  <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
                    <X className="size-8 text-destructive" />
                    <CardTitle>Could not load this file</CardTitle>
                    <Button nativeButton={false} render={<Link href={toRoute(backHref)} />}>
                      Back to folder
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
            {entryQuery.status === "success" && entry !== undefined && (
              <PreviewViewer entry={entry} inlineUrl={inlineUrl} downloadUrl={downloadUrl} />
            )}
          </div>

          {infoOpen && entry !== undefined && (
            <Inspector entries={[entry]} onClose={() => setInfoOpen(false)} />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * The preview route's client shell: top bar (back, name, kind badge,
 * prev/next, download, open in new tab, info toggle), the matching viewer,
 * and the inspector. Renders under the app's shared `QueryClient`
 * (provided by `src/app/providers.tsx`), so its queries share the same
 * cache as the file browser's.
 */
export function PreviewShell({ path }: PreviewShellProps) {
  return <PreviewShellContent path={path} />;
}
