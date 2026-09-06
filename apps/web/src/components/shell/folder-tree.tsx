"use client";

import type { FsEntry } from "@fdrive/contracts";
import { baseName, joinPath } from "@fdrive/core";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { isFilesRoute } from "@/components/shell/app-sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { INTERNAL_DND_TYPE, readDraggedPaths } from "@/lib/dnd";
import { movablePaths } from "@/lib/files/move-guard";
import { pathFromFilesPathname, pathToHref } from "@/lib/files/path-url";
import { useListing, useMove } from "@/lib/files/queries";
import { DEFAULT_SORT_SPEC, sortListing } from "@/lib/files/sorting";
import {
  collapse,
  EMPTY_TREE_STATE,
  expand,
  expandAncestorsOf,
  flattenVisibleTree,
  leftAction,
  moveVisibleFocus,
  readTreeState,
  rightAction,
  type TreeState,
  writeTreeState,
} from "@/lib/files/tree";
import { cn } from "@/lib/utils";

const ROOT_PATH = "/";

// `/files` is served by an optional catch-all route, which Next's typed
// routes only model as `/files/${string}`, not the bare path.
const FILES_ROUTE = "/files" as unknown as Route;

/**
 * Asserts a dynamically built path is a valid Next.js route, the same way
 * the file browser does for paths built at runtime from `pathToHref`.
 */
function toRoute(href: string): Route {
  return href as Route;
}

/** The directory children of `entries`, sorted the same as the browser. */
function dirChildPaths(entries: readonly FsEntry[]): string[] {
  return sortListing(
    entries.filter((entry) => entry.kind === "dir"),
    DEFAULT_SORT_SPEC,
  ).map((entry) => entry.path);
}

function sameChildren(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((path, index) => path === b[index]);
}

interface FolderTreeRowProps {
  path: string;
  treeState: TreeState;
  currentPath: string | null;
  focusPath: string | null;
  childrenByPath: ReadonlyMap<string, readonly string[]>;
  onSetExpanded: (path: string, open: boolean) => void;
  onFocusPath: (path: string) => void;
  onChildrenLoaded: (path: string, children: string[]) => void;
  onDropMove: (paths: string[], targetPath: string) => void;
}

/** One folder in the sidebar tree, and (when expanded) its own children. */
function FolderTreeRow({
  path,
  treeState,
  currentPath,
  focusPath,
  childrenByPath,
  onSetExpanded,
  onFocusPath,
  onChildrenLoaded,
  onDropMove,
}: FolderTreeRowProps) {
  const isExpanded = treeState.expanded.has(path);
  const { data, isLoading } = useListing(path, { enabled: isExpanded });

  useEffect(() => {
    if (data !== undefined) {
      onChildrenLoaded(path, dirChildPaths(data.entries));
    }
  }, [data, path, onChildrenLoaded]);

  const knownChildren = childrenByPath.get(path);
  const hasChevron = knownChildren === undefined || knownChildren.length > 0;
  const name = baseName(path);
  const isActive = path === currentPath;
  const isFocused = path === focusPath;

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (event.dataTransfer.types.includes(INTERNAL_DND_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    const paths = readDraggedPaths(event.dataTransfer);
    if (paths !== null && paths.length > 0) {
      event.preventDefault();
      onDropMove(paths, path);
    }
  }

  return (
    <SidebarMenuSubItem>
      <Collapsible open={isExpanded} onOpenChange={(open) => onSetExpanded(path, open)}>
        <div className="flex items-center gap-0.5">
          {hasChevron ? (
            <CollapsibleTrigger
              aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
              className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")}
              />
            </CollapsibleTrigger>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <SidebarMenuSubButton
            isActive={isActive}
            data-focused={isFocused}
            render={<Link href={toRoute(pathToHref(path))} />}
            onFocus={() => onFocusPath(path)}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="flex-1 data-[focused=true]:ring-1 data-[focused=true]:ring-inset data-[focused=true]:ring-ring"
          >
            <span className="truncate">{name}</span>
          </SidebarMenuSubButton>
        </div>
        <CollapsibleContent>
          {isLoading ? (
            <div className="py-1 pl-8">
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : (
            knownChildren !== undefined &&
            knownChildren.length > 0 && (
              <SidebarMenuSub className="mx-0 border-l-0 pl-3.5">
                {knownChildren.map((childPath) => (
                  <FolderTreeRow
                    key={childPath}
                    path={childPath}
                    treeState={treeState}
                    currentPath={currentPath}
                    focusPath={focusPath}
                    childrenByPath={childrenByPath}
                    onSetExpanded={onSetExpanded}
                    onFocusPath={onFocusPath}
                    onChildrenLoaded={onChildrenLoaded}
                    onDropMove={onDropMove}
                  />
                ))}
              </SidebarMenuSub>
            )
          )}
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuSubItem>
  );
}

/**
 * The sidebar's Finder-like folder tree: a lazily-expanding "Files" root and
 * its folder descendants. Mounted under the Files item in `AppSidebar`.
 */
export function FolderTree() {
  const pathname = usePathname();
  const router = useRouter();
  const currentPath = useMemo(() => pathFromFilesPathname(pathname), [pathname]);

  const [treeState, setTreeStateRaw] = useState<TreeState>(EMPTY_TREE_STATE);
  useEffect(() => {
    setTreeStateRaw(readTreeState(window.localStorage));
  }, []);

  const updateTreeState = useCallback((updater: (prev: TreeState) => TreeState) => {
    setTreeStateRaw((prev) => {
      const next = updater(prev);
      writeTreeState(window.localStorage, next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (currentPath !== null) {
      updateTreeState((prev) => expandAncestorsOf(prev, currentPath));
    }
  }, [currentPath, updateTreeState]);

  const [childrenByPath, setChildrenByPath] = useState<Map<string, readonly string[]>>(
    () => new Map(),
  );
  const handleChildrenLoaded = useCallback((path: string, children: string[]) => {
    setChildrenByPath((prev) => {
      if (sameChildren(prev.get(path), children)) {
        return prev;
      }
      const next = new Map(prev);
      next.set(path, children);
      return next;
    });
  }, []);

  const move = useMove();
  const handleDropMove = useCallback(
    (paths: string[], targetPath: string) => {
      for (const source of movablePaths(paths, targetPath)) {
        move.mutate({ path: source, target: joinPath(targetPath, baseName(source)) });
      }
    },
    [move],
  );

  const [focusPath, setFocusPath] = useState<string | null>(null);

  const handleSetExpanded = useCallback(
    (path: string, open: boolean) => {
      updateTreeState((prev) => (open ? expand(prev, path) : collapse(prev, path)));
    },
    [updateTreeState],
  );

  const isRootExpanded = treeState.expanded.has(ROOT_PATH);
  const { data: rootData, isLoading: isRootLoading } = useListing(ROOT_PATH, {
    enabled: isRootExpanded,
  });
  useEffect(() => {
    if (rootData !== undefined) {
      handleChildrenLoaded(ROOT_PATH, dirChildPaths(rootData.entries));
    }
  }, [rootData, handleChildrenLoaded]);

  const rootChildren = childrenByPath.get(ROOT_PATH);
  const rootHasChevron = rootChildren === undefined || rootChildren.length > 0;
  const rootFocused = focusPath === ROOT_PATH;

  function handleRootDragOver(event: DragEvent<HTMLElement>) {
    if (event.dataTransfer.types.includes(INTERNAL_DND_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }

  function handleRootDrop(event: DragEvent<HTMLElement>) {
    const paths = readDraggedPaths(event.dataTransfer);
    if (paths !== null && paths.length > 0) {
      event.preventDefault();
      handleDropMove(paths, ROOT_PATH);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLLIElement>) {
    const rows = flattenVisibleTree([ROOT_PATH], childrenByPath, treeState.expanded);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusPath(moveVisibleFocus(rows, focusPath, "down"));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusPath(moveVisibleFocus(rows, focusPath, "up"));
      return;
    }
    if (focusPath === null) {
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const firstChild = childrenByPath.get(focusPath)?.[0] ?? null;
      const result = rightAction(treeState, focusPath, firstChild);
      if (result.type === "expand") {
        updateTreeState((prev) => expand(prev, focusPath));
      } else if (result.type === "focusChild") {
        setFocusPath(result.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const result = leftAction(treeState, focusPath);
      if (result.type === "collapse") {
        updateTreeState((prev) => collapse(prev, focusPath));
      } else if (result.type === "focusParent") {
        setFocusPath(result.path);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      router.push(toRoute(pathToHref(focusPath)));
    }
  }

  return (
    <SidebarMenuItem onKeyDown={handleKeyDown}>
      <Collapsible
        open={isRootExpanded}
        onOpenChange={(open) => handleSetExpanded(ROOT_PATH, open)}
      >
        <div className="flex items-center gap-0.5">
          {rootHasChevron ? (
            <CollapsibleTrigger
              aria-label={isRootExpanded ? "Collapse Files" : "Expand Files"}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn("size-3.5 transition-transform", isRootExpanded && "rotate-90")}
              />
            </CollapsibleTrigger>
          ) : (
            <span className="size-5 shrink-0" />
          )}
          <SidebarMenuButton
            isActive={isFilesRoute(pathname)}
            data-focused={rootFocused}
            render={<Link href={FILES_ROUTE} />}
            onFocus={() => setFocusPath(ROOT_PATH)}
            onDragOver={handleRootDragOver}
            onDrop={handleRootDrop}
            className="flex-1 data-[focused=true]:ring-1 data-[focused=true]:ring-inset data-[focused=true]:ring-ring"
          >
            <FolderIcon />
            <span>Files</span>
          </SidebarMenuButton>
        </div>
        <CollapsibleContent>
          {isRootLoading ? (
            <div className="py-1 pl-8">
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : (
            rootChildren !== undefined &&
            rootChildren.length > 0 && (
              <SidebarMenuSub className="mx-0 mt-0.5 border-l-0 pl-3.5">
                {rootChildren.map((childPath) => (
                  <FolderTreeRow
                    key={childPath}
                    path={childPath}
                    treeState={treeState}
                    currentPath={currentPath}
                    focusPath={focusPath}
                    childrenByPath={childrenByPath}
                    onSetExpanded={handleSetExpanded}
                    onFocusPath={setFocusPath}
                    onChildrenLoaded={handleChildrenLoaded}
                    onDropMove={handleDropMove}
                  />
                ))}
              </SidebarMenuSub>
            )
          )}
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}
