"use client";

import type { FsEntry, SearchHit, SearchSnippet } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { FolderIcon } from "lucide-react";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { createDebouncer, type Debounced } from "@/lib/search/debounce";
import {
  apiClient,
  FileIcon,
  pathFromFilesPathname,
  pathToHref,
  viewHref,
} from "@/lib/search/deps";
import {
  DEFAULT_SEARCH_CHIPS,
  SEARCH_TYPE_FILTERS,
  SEARCH_TYPE_LABELS,
  type SearchChipState,
  type SearchTypeFilter,
} from "@/lib/search/filters";
import { splitSnippetSegments } from "@/lib/search/highlight";
import { makeItemValue, parseItemValue } from "@/lib/search/item-value";
import { useSearchResults } from "@/lib/search/queries";
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

/** Renders one snippet's text with its matched ranges wrapped in `<mark>`. */
function SnippetText({ snippet }: { snippet: SearchSnippet }) {
  const segments = useMemo(
    () => splitSnippetSegments(snippet.text, snippet.ranges),
    [snippet.text, snippet.ranges],
  );
  return (
    <p className="truncate text-xs text-muted-foreground">
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

function HitRow({ hit }: { hit: SearchHit }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <HitThumbnail hit={hit} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm">{hit.name}</span>
          <span className="shrink-0 truncate text-xs text-muted-foreground">{hit.path}</span>
        </div>
        {hit.snippets[0] !== undefined ? <SnippetText snippet={hit.snippets[0]} /> : null}
      </div>
    </div>
  );
}

function FolderRow({ folder }: { folder: FsEntry }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <FolderIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm">{folder.name || "Home"}</span>
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
        <span className="truncate text-sm">{item.name}</span>
        <span className="ml-2 truncate text-xs text-muted-foreground">{item.path}</span>
      </div>
    </div>
  );
}

/**
 * The command-palette style search panel: filter chips, sectioned results
 * (Folders, Files, Content matches) or, for an empty query, a Recent
 * section from `localStorage`. Enter opens the highlighted item; Cmd/Ctrl+
 * Enter reveals it in its parent folder instead. Global Cmd/Ctrl+K to open
 * is wired by `SearchButton`, which owns this component's `open` state.
 */
export function SearchPanel({ open, onOpenChange }: SearchPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const currentFolder = pathFromFilesPathname(pathname) ?? "/";

  const [inputValue, setInputValue] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [chips, setChips] = useState<SearchChipState>(DEFAULT_SEARCH_CHIPS);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [selectedValue, setSelectedValue] = useState("");

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
      return;
    }
    setRecent(readRecent(window.localStorage));
  }, [open]);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    debouncerRef.current?.run(value);
  }, []);

  const trimmedQuery = committedQuery.trim();
  const { data: response, isFetching } = useSearchResults(committedQuery, chips, currentFolder, {
    enabled: open && trimmedQuery.length > 0,
  });

  const openItem = useCallback(
    (kind: "folder" | "file", path: string) => {
      const name = baseName(path);
      if (kind === "file") {
        pushRecent(window.localStorage, { path, name, openedAt: new Date().toISOString() });
      }
      onOpenChange(false);
      router.push(toRoute(kind === "folder" ? pathToHref(path) : viewHref(path)));
    },
    [onOpenChange, router],
  );

  const revealItem = useCallback(
    (path: string) => {
      onOpenChange(false);
      router.push(toRoute(revealHref(path)));
    },
    [onOpenChange, router],
  );

  const handleSelect = useCallback(
    (value: string) => {
      const target = parseItemValue(value);
      if (target === null) {
        return;
      }
      openItem(target.kind === "folder" ? "folder" : "file", target.path);
    },
    [openItem],
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
      revealItem(target.path);
    },
    [selectedValue, revealItem],
  );

  const showRecent = trimmedQuery.length === 0;
  const sections = response?.sections;
  const degraded = response?.degraded ?? false;
  const unavailable = response?.unavailable ?? false;
  const noResults =
    !showRecent &&
    !isFetching &&
    sections !== undefined &&
    sections.folders.length === 0 &&
    sections.files.length === 0 &&
    sections.content.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Search files by name or content"
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false} value={selectedValue} onValueChange={setSelectedValue}>
        <CommandInput
          value={inputValue}
          onValueChange={handleInputChange}
          onKeyDownCapture={handleInputKeyDownCapture}
          placeholder="Search files and content..."
        />
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
          <ToggleGroup
            value={[chips.type]}
            onValueChange={(values) =>
              setChips((current) => ({
                ...current,
                type: (values[0] as SearchTypeFilter | undefined) ?? "any",
              }))
            }
            size="sm"
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
          >
            This folder only
          </Toggle>
        </div>
        {degraded ? (
          <p className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            Semantic search unavailable, showing keyword matches.
          </p>
        ) : null}
        <CommandList>
          {showRecent ? (
            recent.length === 0 ? (
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
                        key={folder.path}
                        value={makeItemValue("folder", folder.path)}
                        onSelect={handleSelect}
                      >
                        <FolderRow folder={folder} />
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
                        key={`file:${hit.path}`}
                        value={makeItemValue("file", hit.path)}
                        onSelect={handleSelect}
                      >
                        <HitRow hit={hit} />
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
                      key={`content:${hit.path}`}
                      value={makeItemValue("content", hit.path)}
                      onSelect={handleSelect}
                    >
                      <HitRow hit={hit} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </>
          )}
        </CommandList>
        <div className="flex items-center justify-end gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
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
      </Command>
    </CommandDialog>
  );
}
