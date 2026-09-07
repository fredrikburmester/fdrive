"use client";

import type { FsEntry, ImageSearchHit, SearchHit, SearchSnippet } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { FolderIcon, FolderOpenIcon, ImagesIcon } from "lucide-react";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShellMe } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { identityLabel, navigateAccountItem } from "@/lib/account/identities";
import { useIdentityActions } from "@/lib/account/use-identities";
import { describeApiError } from "@/lib/api/errors";
import { createDebouncer, type Debounced } from "@/lib/search/debounce";
import {
  apiClient,
  FileIcon,
  pathFromFilesPathname,
  pathToHref,
  viewHref,
} from "@/lib/search/deps";
import {
  DEFAULT_ENTER_ACTION,
  type EnterAction,
  readEnterAction,
  writeEnterAction,
} from "@/lib/search/enter-action";
import {
  DEFAULT_SEARCH_CHIPS,
  SEARCH_TYPE_FILTERS,
  SEARCH_TYPE_LABELS,
  type SearchChipState,
  type SearchTypeFilter,
} from "@/lib/search/filters";
import { splitSnippetSegments } from "@/lib/search/highlight";
import { readImageMode, writeImageMode } from "@/lib/search/image-mode";
import { makeItemValue, parseItemValue } from "@/lib/search/item-value";
import { searchPanelLayout } from "@/lib/search/panel-layout";
import { useImageSearchResults, useSearchResults, useSearchStatus } from "@/lib/search/queries";
import { pushRecent, type RecentItem, readRecent } from "@/lib/search/recent";
import { revealHref } from "@/lib/search/reveal";

const DEBOUNCE_MS = 150;

function toRoute(href: string): Route {
  return href as Route;
}

export interface SearchPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** A 32px thumbnail for a hit, falling back to the file-kind icon on load error or absence. */
function HitThumbnail({ hit }: { hit: SearchHit }) {
  const [errored, setErrored] = useState(false);

  if (!hit.hasThumbnail || errored) {
    return (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileIcon kind={hit.kind} ext={hit.ext} mime={hit.mime} />
      </div>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: a 32px thumbnail from the API, not a static asset next/image can optimize
    <img
      src={apiClient.thumbUrl(hit.path, 256)}
      alt=""
      className="size-8 shrink-0 rounded-md object-cover"
      onError={() => setErrored(true)}
    />
  );
}

/**
 * A square tile for one image-search hit: its 256px thumbnail (assumed
 * present, since the row only exists because a thumbnail was embedded) and
 * its name below, truncated to one line.
 */
function ImageHitTile({ hit }: { hit: ImageSearchHit }) {
  const [errored, setErrored] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="aspect-square w-full overflow-hidden rounded-md ring-1 ring-border">
        {errored ? (
          <div className="flex size-full items-center justify-center bg-muted">
            <FileIcon kind="file" ext={hit.ext} mime={hit.mime} />
          </div>
        ) : (
          // biome-ignore lint/performance/noImgElement: a 256px thumbnail from the API, not a static asset next/image can optimize
          <img
            src={apiClient.thumbUrl(hit.path, 256)}
            alt=""
            className="size-full object-cover"
            onError={() => setErrored(true)}
          />
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground">{hit.name}</p>
    </div>
  );
}

/** Renders one snippet's text with its matched ranges wrapped in `<mark>`. */
function SnippetText({ snippet }: { snippet: SearchSnippet }) {
  const segments = useMemo(
    () => splitSnippetSegments(snippet.text, snippet.ranges),
    [snippet.text, snippet.ranges],
  );
  return (
    <p className="line-clamp-2 text-xs text-muted-foreground">
      {segments.map((segment, index) =>
        segment.highlighted ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable derived render of static props
          <mark key={index} className="rounded-sm bg-primary/20 text-foreground">
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable derived render of static props
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

function HitRow({
  hit,
  label,
  iconsOnly,
}: {
  hit: SearchHit;
  label: string | undefined;
  iconsOnly: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      {iconsOnly ? (
        <FileIcon kind={hit.kind} ext={hit.ext} mime={hit.mime} />
      ) : (
        <HitThumbnail hit={hit} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{hit.name}</p>
        <p className="truncate text-xs text-muted-foreground">{hit.path}</p>
        {label ? <p className="truncate text-xs text-muted-foreground">{label}</p> : null}
        {hit.snippets[0] !== undefined ? <SnippetText snippet={hit.snippets[0]} /> : null}
      </div>
    </div>
  );
}

/**
 * The trailing "reveal in folder" action for a Files/Content result row. On
 * desktop it stays visible on hover or keyboard focus only (see
 * `command.tsx`'s `group/command-item`), hidden otherwise so rows stay
 * uncluttered. On mobile there is no hover, so it stays permanently visible
 * at a comfortable 44px touch target instead. Stops the click from
 * bubbling to the `CommandItem`'s own `onSelect`, so revealing never also
 * opens the file.
 */
function RevealButton({
  path,
  onReveal,
  mobile,
}: {
  path: string;
  onReveal: (path: string) => void;
  mobile: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={mobile ? "icon-lg" : "icon"}
            aria-label="Reveal in folder"
            className={
              mobile
                ? "ml-auto size-11 shrink-0"
                : "ml-auto shrink-0 opacity-0 focus-visible:opacity-100 group-hover/command-item:opacity-100 group-focus-within/command-item:opacity-100"
            }
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onReveal(path);
            }}
          />
        }
      >
        <FolderOpenIcon />
      </TooltipTrigger>
      <TooltipContent>Reveal in folder</TooltipContent>
    </Tooltip>
  );
}

function FolderRow({ folder, label }: { folder: FsEntry; label: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <FolderIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{folder.name || "Home"}</p>
        {label ? <p className="truncate text-xs text-muted-foreground">{label}</p> : null}
      </div>
    </div>
  );
}

function RecentRow({ item }: { item: RecentItem }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileIcon kind="file" ext="" mime={null} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{item.name}</p>
        <p className="truncate text-xs text-muted-foreground">{item.path}</p>
      </div>
    </div>
  );
}

/**
 * The command-palette style search panel: filter chips, sectioned results
 * (Folders, Files, Content matches) or, for an empty query, a Recent
 * section from `localStorage`. By default Enter opens the highlighted item
 * and Cmd/Ctrl+Enter reveals it in its parent folder instead; the footer's
 * "Enter opens" preference (persisted via `lib/search/enter-action.ts`) can
 * swap that. Folders always just open, regardless of the preference. Each
 * Files/Content row also has its own "Reveal in folder" button. Global
 * Cmd/Ctrl+K to open is wired by `SearchButton`, which owns this
 * component's `open` state.
 */
export function SearchPanel({ open, onOpenChange }: SearchPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: me } = useShellMe();
  const actions = useIdentityActions();
  const [allLogins, setAllLogins] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const currentFolder = pathFromFilesPathname(pathname) ?? "/";
  const isMobile = useIsMobile();
  const mobileLayout = searchPanelLayout(isMobile) === "mobile";
  const inputRef = useRef<HTMLInputElement>(null);

  const [inputValue, setInputValue] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [chips, setChips] = useState<SearchChipState>(DEFAULT_SEARCH_CHIPS);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [selectedValue, setSelectedValue] = useState("");
  const [enterAction, setEnterActionState] = useState<EnterAction>(DEFAULT_ENTER_ACTION);
  const [imageMode, setImageModeState] = useState(false);
  const { data: searchStatus } = useSearchStatus();
  const imagesAvailable = searchStatus?.images === true;

  const debouncerRef = useRef<Debounced<string> | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createDebouncer<string>(
      (value) => setCommittedQuery(value),
      DEBOUNCE_MS,
    );
  }

  useEffect(() => {
    if (!open) {
      debouncerRef.current?.cancel();
      setInputValue("");
      setCommittedQuery("");
      setChips(DEFAULT_SEARCH_CHIPS);
      setAllLogins(false);
      return;
    }
    setRecent(
      me
        ? readRecent(window.localStorage, {
            accountId: me.account.id,
            identityId: me.activeIdentityId,
          })
        : [],
    );
    setEnterActionState(readEnterAction(window.localStorage));
    setImageModeState(readImageMode(window.sessionStorage));
  }, [open, me]);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    debouncerRef.current?.run(value);
  }, []);

  const handleEnterActionChange = useCallback((action: EnterAction) => {
    setEnterActionState(action);
    writeEnterAction(window.localStorage, action);
  }, []);

  const handleImageModeChange = useCallback((next: boolean) => {
    setImageModeState(next);
    writeImageMode(window.sessionStorage, next);
  }, []);

  const trimmedQuery = committedQuery.trim();
  const imageSearchActive = imageMode && imagesAvailable;
  const {
    data: response,
    isFetching,
    error: searchError,
  } = useSearchResults(committedQuery, chips, currentFolder, {
    enabled: open && trimmedQuery.length > 0 && me !== undefined && !imageSearchActive,
    ...(me
      ? { scope: { accountId: me.account.id, identityId: me.activeIdentityId, all: allLogins } }
      : {}),
  });

  const {
    data: imageResponse,
    isFetching: isImageFetching,
    error: imageSearchError,
  } = useImageSearchResults(committedQuery, {
    enabled: open && imageSearchActive,
  });

  const navigateItem = useCallback(
    async (kind: "folder" | "file" | "reveal", path: string, identityId?: string) => {
      if (!me || actions.pending) return;
      setNavigationError(null);
      const owner = identityId ?? me.activeIdentityId;
      const href =
        kind === "reveal"
          ? revealHref(path)
          : kind === "folder"
            ? pathToHref(path)
            : viewHref(path);
      try {
        await navigateAccountItem(me, owner, href, actions.switch, (target) =>
          router.push(toRoute(target)),
        );
        if (kind === "file")
          pushRecent(
            window.localStorage,
            { path, name: baseName(path), openedAt: new Date().toISOString() },
            { accountId: me.account.id, identityId: owner },
          );
        onOpenChange(false);
      } catch (error) {
        setNavigationError(describeApiError(error));
      }
    },
    [me, actions, router, onOpenChange],
  );

  const openItem = useCallback(
    (kind: "folder" | "file", path: string, identityId?: string) => {
      void navigateItem(kind, path, identityId);
    },
    [navigateItem],
  );
  const revealItem = useCallback(
    (path: string, identityId?: string) => {
      void navigateItem("reveal", path, identityId);
    },
    [navigateItem],
  );

  const handleSelect = useCallback(
    (value: string) => {
      const target = parseItemValue(value);
      if (target === null) {
        return;
      }
      if (target.kind !== "folder" && enterAction === "folder") {
        revealItem(target.path, target.identityId);
        return;
      }
      openItem(target.kind === "folder" ? "folder" : "file", target.path, target.identityId);
    },
    [openItem, revealItem, enterAction],
  );

  const handleInputKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      const target = parseItemValue(selectedValue);
      if (target === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (target.kind !== "folder" && enterAction === "folder") {
        openItem("file", target.path, target.identityId);
        return;
      }
      revealItem(target.path, target.identityId);
    },
    [selectedValue, revealItem, openItem, enterAction],
  );

  const showRecent = trimmedQuery.length === 0;
  const sections = response?.sections as
    | {
        folders: (FsEntry & { identityId?: string })[];
        files: (SearchHit & { identityId?: string })[];
        content: (SearchHit & { identityId?: string })[];
      }
    | undefined;
  const unavailableIds =
    response && "unavailableIdentityIds" in response ? response.unavailableIdentityIds : [];
  const labelFor = (id: string | undefined) =>
    allLogins && id && me ? identityLabel(me.identities, id) : undefined;
  const degraded = response?.degraded ?? false;
  const unavailable = response?.unavailable ?? false;
  const noResults =
    !showRecent &&
    !isFetching &&
    sections !== undefined &&
    sections.folders.length === 0 &&
    sections.files.length === 0 &&
    sections.content.length === 0;
  const imageHits = imageResponse?.hits ?? [];
  const imageUnavailable = imageResponse?.unavailable ?? false;
  const imagePartial = imageResponse?.partial ?? false;
  const imageNoResults =
    !showRecent && !isImageFetching && imageResponse !== undefined && imageHits.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Search files by name or content"
      className="sm:max-w-xl"
      mobile={mobileLayout}
      initialFocus={mobileLayout ? (inputRef as RefObject<HTMLElement | null>) : undefined}
    >
      <Command
        shouldFilter={false}
        value={selectedValue}
        onValueChange={setSelectedValue}
        className={mobileLayout ? "rounded-none!" : undefined}
      >
        <CommandInput
          ref={inputRef}
          value={inputValue}
          onValueChange={handleInputChange}
          onKeyDownCapture={handleInputKeyDownCapture}
          placeholder="Search files and content..."
        />
        {me && me.identities.length > 1 && !imageSearchActive ? (
          <ToggleGroup
            aria-label="Search scope"
            className="justify-start px-2 pt-2"
            value={[allLogins ? "all" : "current"]}
            onValueChange={(values) => {
              setAllLogins(values[0] === "all");
              setSelectedValue("");
            }}
          >
            <ToggleGroupItem value="current">Current login</ToggleGroupItem>
            <ToggleGroupItem value="all">All linked logins</ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        <div
          className={
            mobileLayout
              ? "flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-border px-2 py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              : "flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5"
          }
        >
          {imageSearchActive ? null : (
            <>
              <ToggleGroup
                value={[chips.type]}
                onValueChange={(values) =>
                  setChips((current) => ({
                    ...current,
                    type: (values[0] as SearchTypeFilter | undefined) ?? "any",
                  }))
                }
                size="sm"
                className={mobileLayout ? "shrink-0" : undefined}
              >
                {SEARCH_TYPE_FILTERS.map((type) => (
                  <ToggleGroupItem key={type} value={type} aria-label={SEARCH_TYPE_LABELS[type]}>
                    {SEARCH_TYPE_LABELS[type]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <Toggle
                size="sm"
                variant="outline"
                pressed={chips.folderOnly}
                onPressedChange={(pressed) =>
                  setChips((current) => ({ ...current, folderOnly: pressed }))
                }
                className={mobileLayout ? "shrink-0" : undefined}
              >
                This folder only
              </Toggle>
            </>
          )}
          {imagesAvailable ? (
            <Toggle
              size="sm"
              variant="outline"
              pressed={imageMode}
              onPressedChange={handleImageModeChange}
              aria-label="Search images"
              className={mobileLayout ? "ml-auto shrink-0" : "ml-auto"}
            >
              <ImagesIcon />
              Images
            </Toggle>
          ) : null}
        </div>
        {actions.error ||
        navigationError ||
        searchError ||
        (imageSearchActive && imageSearchError) ? (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {actions.error ??
              navigationError ??
              describeApiError(imageSearchActive ? imageSearchError : searchError)}
          </p>
        ) : null}
        {!imageSearchActive && unavailableIds.length > 0 && me ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Search unavailable for{" "}
            {unavailableIds.map((id) => identityLabel(me.identities, id)).join(", ")}. Other results
            remain available.
          </p>
        ) : null}
        {imageSearchActive && imagePartial ? (
          <p className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            Some results omitted.
          </p>
        ) : null}
        {!imageSearchActive && degraded ? (
          <p className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            Semantic search unavailable, showing keyword matches.
          </p>
        ) : null}
        <CommandList className={mobileLayout ? "max-h-none min-h-0 flex-1" : undefined}>
          {showRecent ? (
            allLogins || recent.length === 0 ? (
              <CommandEmpty>Type to search files and content.</CommandEmpty>
            ) : (
              <CommandGroup heading="Recent">
                {recent.map((item) => (
                  <CommandItem
                    key={item.path}
                    value={makeItemValue("recent", item.path)}
                    onSelect={handleSelect}
                  >
                    <RecentRow item={item} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          ) : imageSearchActive ? (
            imageUnavailable ? (
              <CommandEmpty>Image search is not available.</CommandEmpty>
            ) : imageNoResults ? (
              <CommandEmpty>No matching images</CommandEmpty>
            ) : (
              <CommandGroup heading="Images">
                <div className="grid grid-cols-3 gap-2 p-1 sm:grid-cols-4">
                  {imageHits.map((hit) => (
                    <CommandItem
                      key={makeItemValue("file", hit.path)}
                      value={makeItemValue("file", hit.path)}
                      onSelect={handleSelect}
                      className="flex-col items-stretch gap-1"
                    >
                      <ImageHitTile hit={hit} />
                    </CommandItem>
                  ))}
                </div>
              </CommandGroup>
            )
          ) : unavailable ? (
            <CommandEmpty>Search is not available.</CommandEmpty>
          ) : noResults ? (
            <CommandEmpty>No results for "{trimmedQuery}".</CommandEmpty>
          ) : (
            <>
              {sections !== undefined && sections.folders.length > 0 ? (
                <>
                  <CommandGroup heading="Folders">
                    {sections.folders.map((folder) => (
                      <CommandItem
                        key={makeItemValue("folder", folder.path, folder.identityId)}
                        value={makeItemValue("folder", folder.path, folder.identityId)}
                        onSelect={handleSelect}
                      >
                        <FolderRow folder={folder} label={labelFor(folder.identityId)} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandSeparator />
                </>
              ) : null}
              {sections !== undefined && sections.files.length > 0 ? (
                <>
                  <CommandGroup heading="Files">
                    {sections.files.map((hit) => (
                      <CommandItem
                        key={makeItemValue("file", hit.path, hit.identityId)}
                        value={makeItemValue("file", hit.path, hit.identityId)}
                        onSelect={handleSelect}
                      >
                        <HitRow hit={hit} iconsOnly={allLogins} label={labelFor(hit.identityId)} />
                        <RevealButton
                          path={hit.path}
                          onReveal={(path) => revealItem(path, hit.identityId)}
                          mobile={mobileLayout}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {sections.content.length > 0 ? <CommandSeparator /> : null}
                </>
              ) : null}
              {sections !== undefined && sections.content.length > 0 ? (
                <CommandGroup heading="Content matches">
                  {sections.content.map((hit) => (
                    <CommandItem
                      key={makeItemValue("content", hit.path, hit.identityId)}
                      value={makeItemValue("content", hit.path, hit.identityId)}
                      onSelect={handleSelect}
                    >
                      <HitRow hit={hit} iconsOnly={allLogins} label={labelFor(hit.identityId)} />
                      <RevealButton
                        path={hit.path}
                        onReveal={(path) => revealItem(path, hit.identityId)}
                        mobile={mobileLayout}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </>
          )}
        </CommandList>
        {mobileLayout ? null : (
          <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span>Enter opens:</span>
              <ToggleGroup
                value={[enterAction]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === "file" || next === "folder") {
                    handleEnterActionChange(next);
                  }
                }}
                size="sm"
              >
                <ToggleGroupItem value="file">File</ToggleGroupItem>
                <ToggleGroupItem value="folder">Enclosing folder</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {enterAction === "folder" ? (
              <div className="flex items-center gap-3">
                <KbdGroup>
                  <Kbd>Enter</Kbd>
                  <span>reveal</span>
                </KbdGroup>
                <KbdGroup>
                  <Kbd>⌘</Kbd>
                  <Kbd>Enter</Kbd>
                  <span>open</span>
                </KbdGroup>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <KbdGroup>
                  <Kbd>Enter</Kbd>
                  <span>open</span>
                </KbdGroup>
                <KbdGroup>
                  <Kbd>⌘</Kbd>
                  <Kbd>Enter</Kbd>
                  <span>reveal</span>
                </KbdGroup>
              </div>
            )}
          </div>
        )}
      </Command>
    </CommandDialog>
  );
}
