"use client";

import type { ArchiveFormat, CompressRequest, ExtractRequest, FsEntry } from "@fdrive/contracts";
import { baseName, isRoot, joinPath, parentPath } from "@fdrive/core";
import { useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { NewFileDialog } from "@/components/editor/new-file-dialog";
import { Inspector } from "@/components/inspector/inspector";
import { TagsEditDialog } from "@/components/metadata/tags-edit-dialog";
import { Button } from "@/components/ui/button";
import { DropOverlay, useExternalDrop } from "@/components/upload/drop-overlay";
import { useUploadFilesContext } from "@/components/upload/upload-provider";
import type { NewFileKind } from "@/lib/editor/new-file";
import { editHref } from "@/lib/editor/route";
import { defaultArchiveName, extractDestinationUnder } from "@/lib/files/archive";
import { apiClient, PageHeader, queryKeys } from "@/lib/files/deps";
import {
  type AnchorDownloader,
  createAnchorDownloader,
  type DocumentLike,
  type DownloadDeps,
  downloadMany,
  downloadSingle,
  needsZipDownload,
} from "@/lib/files/download";
import { readInspectorOpen, writeInspectorOpen } from "@/lib/files/inspector-visibility";
import { keyToAction } from "@/lib/files/keyboard";
import { movablePaths } from "@/lib/files/move-guard";
import { pathToHref, viewHref } from "@/lib/files/path-url";
import { detectPlatform } from "@/lib/files/platform";
import {
  describeFsError,
  useCopy,
  useDelete,
  useDuplicate,
  useListing,
  useMkdir,
  useMove,
  useRename,
  useTreeChildren,
} from "@/lib/files/queries";
import { parseSelectParam } from "@/lib/files/reveal";
import {
  contextEntries,
  EMPTY_SELECTION,
  type SelectionAction,
  type SelectionState,
  selectionReducer,
} from "@/lib/files/selection";
import {
  DEFAULT_SORT_SPEC,
  readSortSpec,
  type SortSpec,
  sortListing,
  writeSortSpec,
} from "@/lib/files/sorting";
import {
  collapse as collapseTree,
  EMPTY_TREE_STATE,
  expand as expandTree,
  readTreeState,
  type TreeState,
  toggle as toggleTree,
  writeTreeState,
} from "@/lib/files/tree";
import { flattenTree } from "@/lib/files/tree-rows";
import {
  EMPTY_TYPE_AHEAD_BUFFER,
  nextTypeAheadBuffer,
  type TypeAheadBuffer,
  typeAheadMatch,
} from "@/lib/files/type-ahead";
import {
  DEFAULT_VIEW_MODE,
  readViewMode,
  type ViewMode,
  writeViewMode,
} from "@/lib/files/view-mode";
import { type RunJobRequestDeps, runJobRequest } from "@/lib/jobs/actions";
import { useJobsStore } from "@/lib/jobs/store";
import type { JobRequest } from "@/lib/jobs/types";
import type { TagColor } from "@/lib/metadata/colors";
import {
  useSetFileTags,
  useTagMutations,
  useTags,
  useToggleFavorite,
} from "@/lib/metadata/queries";
import { tagCheckState as computeTagCheckState, toggleTagId } from "@/lib/metadata/tag-set";
import { collectInputFiles } from "@/lib/upload/traverse";
import { CompressDialog, type CompressDialogState } from "./compress-dialog";
import { DeleteDialog } from "./delete-dialog";
import { DestinationPicker, type DestinationPickerMode } from "./destination-picker";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import type { RowContextAction } from "./file-context-menu";
import { FileGrid } from "./file-grid";
import { type ClickModifierKeys, FileList } from "./file-list";
import { ListingSkeleton } from "./listing-skeleton";
import { NewFolderDialog } from "./new-folder-dialog";
import { RenameDialog } from "./rename-dialog";
import { FilesBreadcrumb, FilesToolbarActions } from "./toolbar";

export interface FileBrowserProps {
  path: string;
  onOpen?: (entry: FsEntry) => void;
  onRequestUpload?: (files?: FileList) => void;
  onSelectionChange?: (entries: FsEntry[]) => void;
}

/** A stable empty set, so passing "no folders expanded" never busts memoization. */
const EMPTY_EXPANDED: ReadonlySet<string> = new Set();

function deleteItemKind(entry: FsEntry): "file" | "dir" {
  return entry.kind === "dir" ? "dir" : "file";
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

/**
 * Adapts the real, global `document` to `download.ts`'s minimal
 * `DocumentLike`. The cast is confined to this one boundary: `download.ts`
 * only ever calls the methods its narrow interface declares (create one
 * anchor, append it, click it, remove it), so this is safe even though a
 * real `Node` is structurally much larger than `AnchorLike`.
 */
function adaptDocument(doc: Document): DocumentLike {
  return {
    createElement: (tag) => doc.createElement(tag),
    body: {
      appendChild: (node) => {
        doc.body.appendChild(node as unknown as Node);
      },
      removeChild: (node) => {
        doc.body.removeChild(node as unknown as Node);
      },
    },
  };
}

/** Builds a fresh `DownloadDeps` bound to the current `document`. Only ever
 * called from an event handler, never at render time, so it never runs
 * during server-side rendering. */
function buildDownloadDeps(anchor: AnchorDownloader): DownloadDeps {
  return {
    downloadUrl: (downloadPath, opts) => apiClient.downloadUrl(downloadPath, opts),
    zip: (paths, name) => apiClient.zip(paths, name),
    anchor,
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}

type DirectoryInputElement = HTMLInputElement & { webkitdirectory: boolean };

/**
 * Owns the listing query, selection, sort, view mode, keyboard handling,
 * context menus, dialogs, and the internal/external drop target for a
 * single folder.
 */
export function FileBrowser({
  path,
  onOpen,
  onRequestUpload,
  onSelectionChange,
}: FileBrowserProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectName = parseSelectParam(searchParams.toString());
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useListing(path);
  const entries = useMemo(() => data?.entries ?? [], [data]);

  const [sortSpec, setSortSpecState] = useState<SortSpec>(DEFAULT_SORT_SPEC);
  const [viewMode, setViewModeState] = useState<ViewMode>(DEFAULT_VIEW_MODE);
  const [treeState, setTreeStateRaw] = useState<TreeState>(EMPTY_TREE_STATE);
  useEffect(() => {
    setSortSpecState(readSortSpec(window.localStorage));
    setViewModeState(readViewMode(window.localStorage));
    setTreeStateRaw(readTreeState(window.localStorage));
  }, []);

  function setSortSpec(spec: SortSpec) {
    setSortSpecState(spec);
    writeSortSpec(window.localStorage, spec);
  }
  function setViewMode(mode: ViewMode) {
    setViewModeState(mode);
    writeViewMode(window.localStorage, mode);
  }
  function updateTreeState(updater: (prev: TreeState) => TreeState) {
    setTreeStateRaw((prev) => {
      const next = updater(prev);
      writeTreeState(window.localStorage, next);
      return next;
    });
  }

  const sortedEntries = useMemo(() => sortListing(entries, sortSpec), [entries, sortSpec]);

  const activeTreeExpanded = viewMode === "tree" ? treeState.expanded : EMPTY_EXPANDED;
  const childrenByPath = useTreeChildren(entries, activeTreeExpanded);
  const treeRows = useMemo(
    () =>
      viewMode === "tree" ? flattenTree(entries, treeState.expanded, childrenByPath, sortSpec) : [],
    [viewMode, entries, treeState.expanded, childrenByPath, sortSpec],
  );
  const treeDepths = useMemo(
    () => new Map(treeRows.map((row) => [row.entry.path, row.depth])),
    [treeRows],
  );
  const displayEntries = viewMode === "tree" ? treeRows.map((row) => row.entry) : sortedEntries;
  const orderedPaths = useMemo(() => displayEntries.map((entry) => entry.path), [displayEntries]);

  const [selection, dispatchSelection] = useReducer(
    (state: SelectionState, action: SelectionAction) =>
      selectionReducer(state, action, orderedPaths),
    EMPTY_SELECTION,
  );

  useEffect(() => {
    dispatchSelection({ type: "reconcile", paths: orderedPaths });
  }, [orderedPaths]);

  const selectedEntries = useMemo(
    () => displayEntries.filter((entry) => selection.selected.has(entry.path)),
    [displayEntries, selection.selected],
  );

  useEffect(() => {
    onSelectionChange?.(selectedEntries);
  }, [selectedEntries, onSelectionChange]);

  const mkdir = useMkdir();
  const rename = useRename();
  const move = useMove();
  const copy = useCopy();
  const remove = useDelete();
  const duplicate = useDuplicate();

  const tagsQuery = useTags();
  const tags = tagsQuery.data ?? [];
  const setFileTags = useSetFileTags();
  const toggleFavorite = useToggleFavorite();
  const { createTag } = useTagMutations();
  const [tagsEditorEntries, setTagsEditorEntries] = useState<FsEntry[] | null>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFileKind, setNewFileKind] = useState<NewFileKind | null>(null);
  const [newFilePending, setNewFilePending] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<FsEntry[]>([]);
  const [destinationPicker, setDestinationPicker] = useState<{
    mode: DestinationPickerMode;
    paths: string[];
  } | null>(null);
  const [compressState, setCompressState] = useState<CompressDialogState | null>(null);
  // Hidden (not unmounted, so its own state survives) while the "Change
  // destination" flow's own DestinationPicker is open, so the two dialogs
  // never show at once.
  const compressDialogState =
    destinationPicker?.mode === "compressDestination" ? null : compressState;
  const [detailsOpen, setDetailsOpenState] = useState(false);
  useEffect(() => {
    setDetailsOpenState(readInspectorOpen(window.localStorage));
  }, []);

  function setDetailsOpen(open: boolean) {
    setDetailsOpenState(open);
    writeInspectorOpen(window.localStorage, open);
  }

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<DirectoryInputElement | null>(null);
  const typeAheadRef = useRef<TypeAheadBuffer>(EMPTY_TYPE_AHEAD_BUFFER);
  const anchorRef = useRef<AnchorDownloader | null>(null);
  const listingRef = useRef<HTMLDivElement>(null);

  const { uploadFiles } = useUploadFilesContext();
  const existingNames = useMemo(() => new Set(entries.map((entry) => entry.name)), [entries]);
  const destinationName = isRoot(path) ? "Home" : baseName(path);
  const { isDraggingOver } = useExternalDrop(listingRef, (files) => {
    uploadFiles(files, path, existingNames);
  });

  // "Reveal in folder" (from the search panel): once this folder's listing
  // has loaded and contains the named item, select it, scroll it into
  // view, and drop the `select` param so a reload does not re-select it.
  useEffect(() => {
    if (selectName === null || isLoading) {
      return;
    }
    const targetPath = joinPath(path, selectName);
    if (!orderedPaths.includes(targetPath)) {
      return;
    }
    dispatchSelection({ type: "set", paths: [targetPath] });
    const row = listingRef.current
      ? Array.from(listingRef.current.querySelectorAll<HTMLElement>("[data-path]")).find(
          (element) => element.dataset.path === targetPath,
        )
      : undefined;
    row?.scrollIntoView({ block: "nearest" });
    router.replace(toRoute(pathToHref(path)));
  }, [selectName, isLoading, orderedPaths, path, router]);

  function getAnchorDownloader(): AnchorDownloader {
    if (anchorRef.current === null) {
      anchorRef.current = createAnchorDownloader(adaptDocument(document));
    }
    return anchorRef.current;
  }

  function pathsForAction(entry: FsEntry): string[] {
    if (selection.selected.has(entry.path) && selection.selected.size > 1) {
      return [...selection.selected];
    }
    return [entry.path];
  }

  /** Wires `runJobRequest` (compress/extract) to the real API client, jobs store, and toasts. */
  function buildJobRequestDeps(): RunJobRequestDeps {
    return {
      compress: (req: CompressRequest) => apiClient.compress(req),
      extract: (req: ExtractRequest) => apiClient.extract(req),
      seedJob: (job, request) => useJobsStore.getState().seed(job, request),
      notifySuccess: (message) => toast.success(message),
      notifyError: (message) => toast.error(message),
    };
  }

  function submitJobRequest(request: JobRequest) {
    void runJobRequest(buildJobRequestDeps(), request);
  }

  function openCompressDialog(paths: string[]) {
    const first = paths[0];
    if (first === undefined) {
      return;
    }
    setCompressState({
      paths,
      format: "zip",
      name: defaultArchiveName(paths),
      destination: parentPath(first),
    });
  }

  function entriesForAction(entry: FsEntry): FsEntry[] {
    return contextEntries(entry, displayEntries, selection.selected);
  }

  function handleOpen(entry: FsEntry) {
    if (onOpen) {
      onOpen(entry);
      return;
    }
    router.push(toRoute(entry.kind === "dir" ? pathToHref(entry.path) : viewHref(entry.path)));
  }

  function handleEntryClick(entry: FsEntry, modifiers: ClickModifierKeys) {
    dispatchSelection({ type: "click", path: entry.path, modifiers });
  }

  function handleInternalDrop(paths: string[], targetFolderPath: string, effect: "move" | "copy") {
    const mutation = effect === "copy" ? copy : move;
    for (const source of movablePaths(paths, targetFolderPath)) {
      mutation.mutate({ path: source, target: joinPath(targetFolderPath, baseName(source)) });
    }
  }

  function handleToggleTreeExpand(entry: FsEntry) {
    updateTreeState((prev) => toggleTree(prev, entry.path));
  }

  function handleToggleSelectAll() {
    dispatchSelection({ type: "toggleAll", visiblePaths: orderedPaths });
  }

  function currentTagIds(path: string): readonly string[] {
    return entries.find((candidate) => candidate.path === path)?.meta?.tagIds ?? [];
  }

  function handleToggleTag(paths: readonly string[], tagId: string, checked: boolean) {
    setFileTags.mutate(
      paths.map((path) => ({ path, tagIds: toggleTagId(currentTagIds(path), tagId, checked) })),
    );
  }

  function handleOpenTagsEditor(targets: readonly FsEntry[]) {
    setTagsEditorEntries([...targets]);
  }

  function handleToggleFavorite(paths: readonly string[], next: boolean) {
    for (const path of paths) {
      toggleFavorite.mutate({ path, favorite: next });
    }
  }

  function handleCreateTagFromEditor(name: string, color: TagColor) {
    createTag.mutate(
      { name, color: color === "none" ? null : color },
      {
        onSuccess: (tag) => {
          const targets = tagsEditorEntries ?? [];
          setFileTags.mutate(
            targets.map((target) => ({
              path: target.path,
              tagIds: [...currentTagIds(target.path), tag.id],
            })),
          );
        },
      },
    );
  }

  function handleContextAction(action: RowContextAction, entry: FsEntry) {
    switch (action) {
      case "open":
        handleOpen(entry);
        break;
      case "download": {
        const paths = pathsForAction(entry);
        const deps = buildDownloadDeps(getAnchorDownloader());
        const first = paths[0];
        if (!needsZipDownload(entriesForAction(entry)) && first !== undefined) {
          downloadSingle(first, deps);
        } else {
          downloadMany(paths, deps, `${defaultArchiveName(paths)}.zip`).catch(() =>
            toast.error("Could not download the selection."),
          );
        }
        break;
      }
      case "rename":
        setRenameTarget(entry);
        break;
      case "moveTo":
        setDestinationPicker({ mode: "move", paths: pathsForAction(entry) });
        break;
      case "copyTo":
        setDestinationPicker({ mode: "copy", paths: pathsForAction(entry) });
        break;
      case "delete":
        setDeleteTargets(entriesForAction(entry));
        break;
      case "duplicate":
        duplicate.mutate(entry.path, {
          onSuccess: (newEntry) => {
            toast.success(`Duplicated as "${newEntry.name}"`);
            dispatchSelection({ type: "set", paths: [newEntry.path] });
          },
        });
        break;
      case "compress":
        openCompressDialog(pathsForAction(entry));
        break;
      case "extractHere":
        submitJobRequest({ kind: "extract", req: { path: entry.path } });
        break;
      case "extractTo":
        setDestinationPicker({ mode: "extractTo", paths: [entry.path] });
        break;
    }
  }

  function handleDuplicateSelection() {
    const only = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
    if (only === undefined) {
      return;
    }
    duplicate.mutate(only.path, {
      onSuccess: (newEntry) => {
        toast.success(`Duplicated as "${newEntry.name}"`);
        dispatchSelection({ type: "set", paths: [newEntry.path] });
      },
    });
  }

  function handleCompressSelection() {
    if (selectedEntries.length === 0) {
      return;
    }
    openCompressDialog(selectedEntries.map((entry) => entry.path));
  }

  function handleCreateFolder(name: string) {
    mkdir.mutate(joinPath(path, name), {
      onSuccess: (entry) => {
        setNewFolderOpen(false);
        dispatchSelection({ type: "set", paths: [entry.path] });
      },
    });
  }

  async function handleCreateFile(name: string) {
    if (newFileKind === null) {
      return;
    }
    setNewFilePending(true);
    const targetPath = joinPath(path, name);
    try {
      await apiClient.upload(targetPath, new Blob([]), { contentLength: 0 });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fs.list(path) });
      setNewFileKind(null);
      router.push(toRoute(editHref(targetPath)));
    } catch (err) {
      toast.error(describeFsError(err, "Could not create the file."));
    } finally {
      setNewFilePending(false);
    }
  }

  function handleRenameSubmit(newName: string) {
    if (renameTarget === null) {
      return;
    }
    rename.mutate({ path: renameTarget.path, newName }, { onSuccess: () => setRenameTarget(null) });
  }

  function handleDeleteConfirm() {
    remove.mutate(
      deleteTargets.map((entry) => ({ path: entry.path, kind: deleteItemKind(entry) })),
      { onSuccess: () => setDeleteTargets([]) },
    );
  }

  function handleDestinationConfirm(destinationDir: string) {
    if (destinationPicker === null) {
      return;
    }

    if (destinationPicker.mode === "compressDestination") {
      setCompressState((prev) => (prev === null ? prev : { ...prev, destination: destinationDir }));
      setDestinationPicker(null);
      return;
    }

    if (destinationPicker.mode === "extractTo") {
      const archivePath = destinationPicker.paths[0];
      setDestinationPicker(null);
      if (archivePath !== undefined) {
        submitJobRequest({
          kind: "extract",
          req: {
            path: archivePath,
            destination: extractDestinationUnder(archivePath, destinationDir),
          },
        });
      }
      return;
    }

    const mutation = destinationPicker.mode === "move" ? move : copy;
    for (const source of destinationPicker.paths) {
      mutation.mutate({ path: source, target: joinPath(destinationDir, baseName(source)) });
    }
    setDestinationPicker(null);
  }

  function handleCompressSubmit() {
    if (compressState === null) {
      return;
    }
    const name = compressState.name.trim();
    if (name.length === 0) {
      return;
    }
    const req: CompressRequest = {
      paths: [...compressState.paths],
      format: compressState.format,
      name,
      destination: compressState.destination,
    };
    setCompressState(null);
    submitJobRequest({ kind: "compress", req });
  }

  function handleUploadFiles() {
    fileInputRef.current?.click();
  }
  function handleUploadFolder() {
    folderInputRef.current?.click();
  }
  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    // Copy the FileList before resetting `input.value`: resetting first can
    // clear (or invalidate, depending on the browser) the same FileList
    // object this handler is about to read, making the selection appear
    // empty. Copying to a plain array first, then resetting, is safe.
    const collected = files === null ? [] : Array.from(files);
    event.target.value = "";
    if (collected.length === 0) {
      return;
    }
    if (onRequestUpload) {
      onRequestUpload(files ?? undefined);
      return;
    }
    uploadFiles(collectInputFiles(collected), path, existingNames);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return;
    }

    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const buffer = nextTypeAheadBuffer(typeAheadRef.current, event.key, Date.now());
      typeAheadRef.current = buffer;
      const currentIndex = selection.focus === null ? -1 : orderedPaths.indexOf(selection.focus);
      const matchIndex = typeAheadMatch(
        displayEntries.map((entry) => entry.name),
        buffer.query,
        currentIndex + 1,
      );
      if (matchIndex !== null) {
        const matchedPath = orderedPaths[matchIndex];
        if (matchedPath !== undefined) {
          dispatchSelection({ type: "click", path: matchedPath });
        }
      }
      return;
    }

    const platform = detectPlatform(typeof navigator === "undefined" ? undefined : navigator);
    const action = keyToAction(event, platform, viewMode === "tree");
    if (action === null) {
      return;
    }
    event.preventDefault();

    switch (action.type) {
      case "move":
        dispatchSelection({
          type: "arrow",
          direction: action.direction,
          modifiers: { shift: action.extend },
        });
        break;
      case "open": {
        const entry = displayEntries.find((candidate) => candidate.path === selection.focus);
        if (entry !== undefined) {
          handleOpen(entry);
        }
        break;
      }
      case "quickLook": {
        const entry = displayEntries.find((candidate) => candidate.path === selection.focus);
        if (entry !== undefined) {
          router.push(toRoute(viewHref(entry.path)));
        }
        break;
      }
      case "delete":
        if (selectedEntries.length > 0) {
          setDeleteTargets(selectedEntries);
        }
        break;
      case "selectAll":
        dispatchSelection({ type: "selectAll" });
        break;
      case "clear":
        dispatchSelection({ type: "clear" });
        break;
      case "rename": {
        const entry = displayEntries.find((candidate) => candidate.path === selection.focus);
        if (entry !== undefined) {
          setRenameTarget(entry);
        }
        break;
      }
      case "expand": {
        const entry = displayEntries.find((candidate) => candidate.path === selection.focus);
        if (entry !== undefined && entry.kind === "dir") {
          updateTreeState((prev) => expandTree(prev, entry.path));
        }
        break;
      }
      case "collapse": {
        const entry = displayEntries.find((candidate) => candidate.path === selection.focus);
        if (entry !== undefined && entry.kind === "dir") {
          updateTreeState((prev) => collapseTree(prev, entry.path));
        }
        break;
      }
      case "download": {
        if (selectedEntries.length === 0) {
          break;
        }
        const deps = buildDownloadDeps(getAnchorDownloader());
        const first = selectedEntries[0];
        const paths = selectedEntries.map((selectedEntry) => selectedEntry.path);
        if (!needsZipDownload(selectedEntries) && first !== undefined) {
          downloadSingle(first.path, deps);
        } else {
          downloadMany(paths, deps, `${defaultArchiveName(paths)}.zip`).catch(() =>
            toast.error("Could not download the selection."),
          );
        }
        break;
      }
      case "newFolder":
        setNewFolderOpen(true);
        break;
      case "goToParent":
        router.push(toRoute(pathToHref(parentPath(path))));
        break;
      case "setView":
        setViewMode(action.mode);
        break;
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={<FilesBreadcrumb path={path} onInternalDrop={handleInternalDrop} />}
        actions={
          <FilesToolbarActions
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            sortSpec={sortSpec}
            onSortSpecChange={setSortSpec}
            onNewFolder={() => setNewFolderOpen(true)}
            onNewFile={setNewFileKind}
            onUploadFiles={handleUploadFiles}
            onUploadFolder={handleUploadFolder}
            detailsOpen={detailsOpen}
            onToggleDetails={() => setDetailsOpen(!detailsOpen)}
            selectedCount={selection.selected.size}
            onClearSelection={() => dispatchSelection({ type: "clear" })}
            onDuplicateSelection={handleDuplicateSelection}
            onCompressSelection={handleCompressSelection}
          />
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={(element) => {
          if (element !== null) {
            (element as DirectoryInputElement).webkitdirectory = true;
          }
          folderInputRef.current = element as DirectoryInputElement | null;
        }}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {/** biome-ignore lint/a11y/noStaticElementInteractions: this is the keyboard and drop host for the whole listing, like Finder's content view; the interactive rows inside handle their own semantics */}
          <div
            ref={listingRef}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: this hosts roving keyboard navigation across the virtualized rows, like Finder's content view
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="h-full outline-none"
          >
            {isLoading ? (
              <ListingSkeleton variant={viewMode === "grid" ? "grid" : "list"} />
            ) : isError ? (
              <ErrorState
                message={describeFsError(error, "Something went wrong.")}
                onRetry={() => refetch()}
              />
            ) : sortedEntries.length === 0 ? (
              <EmptyState
                action={
                  <Button variant="outline" size="sm" onClick={handleUploadFiles}>
                    Upload
                  </Button>
                }
              />
            ) : viewMode === "list" ? (
              <FileList
                entries={sortedEntries}
                selected={selection.selected}
                focusedPath={selection.focus}
                onEntryClick={handleEntryClick}
                onEntryDoubleClick={handleOpen}
                onContextAction={handleContextAction}
                getDragPaths={pathsForAction}
                onInternalDrop={handleInternalDrop}
                onToggleSelectAll={handleToggleSelectAll}
                onChangeSelection={(paths) => dispatchSelection({ type: "set", paths })}
                onClearSelection={() => dispatchSelection({ type: "clear" })}
                tags={tags}
                onToggleTag={handleToggleTag}
                onOpenTagsEditor={handleOpenTagsEditor}
                onToggleFavorite={handleToggleFavorite}
              />
            ) : viewMode === "grid" ? (
              <FileGrid
                entries={sortedEntries}
                selected={selection.selected}
                focusedPath={selection.focus}
                onEntryClick={handleEntryClick}
                onEntryDoubleClick={handleOpen}
                onContextAction={handleContextAction}
                getDragPaths={pathsForAction}
                onInternalDrop={handleInternalDrop}
                onToggleSelectAll={handleToggleSelectAll}
                onChangeSelection={(paths) => dispatchSelection({ type: "set", paths })}
                onClearSelection={() => dispatchSelection({ type: "clear" })}
                tags={tags}
                onToggleTag={handleToggleTag}
                onOpenTagsEditor={handleOpenTagsEditor}
                onToggleFavorite={handleToggleFavorite}
              />
            ) : (
              <FileList
                entries={displayEntries}
                selected={selection.selected}
                focusedPath={selection.focus}
                onEntryClick={handleEntryClick}
                onEntryDoubleClick={handleOpen}
                onContextAction={handleContextAction}
                getDragPaths={pathsForAction}
                onInternalDrop={handleInternalDrop}
                onToggleSelectAll={handleToggleSelectAll}
                onChangeSelection={(paths) => dispatchSelection({ type: "set", paths })}
                onClearSelection={() => dispatchSelection({ type: "clear" })}
                treeDepths={treeDepths}
                treeExpanded={treeState.expanded}
                onToggleTreeExpand={handleToggleTreeExpand}
                tags={tags}
                onToggleTag={handleToggleTag}
                onOpenTagsEditor={handleOpenTagsEditor}
                onToggleFavorite={handleToggleFavorite}
              />
            )}
          </div>
          <DropOverlay visible={isDraggingOver} destinationName={destinationName} />
        </div>
        {detailsOpen && (
          <Inspector entries={selectedEntries} onClose={() => setDetailsOpen(false)} />
        )}
      </div>

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        onCreate={handleCreateFolder}
        pending={mkdir.isPending}
      />
      <NewFileDialog
        kind={newFileKind}
        onOpenChange={(open) => {
          if (!open) {
            setNewFileKind(null);
          }
        }}
        onCreate={(name) => void handleCreateFile(name)}
        pending={newFilePending}
      />
      <RenameDialog
        entry={renameTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
          }
        }}
        onRename={handleRenameSubmit}
        pending={rename.isPending}
      />
      <DeleteDialog
        entries={deleteTargets}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTargets([]);
          }
        }}
        onConfirm={handleDeleteConfirm}
        pending={remove.isPending}
      />
      {destinationPicker !== null && (
        <DestinationPicker
          open
          mode={destinationPicker.mode}
          initialPath={path}
          onOpenChange={(open) => {
            if (!open) {
              setDestinationPicker(null);
            }
          }}
          onConfirm={handleDestinationConfirm}
          pending={
            destinationPicker.mode === "move"
              ? move.isPending
              : destinationPicker.mode === "copy"
                ? copy.isPending
                : false
          }
        />
      )}
      <CompressDialog
        state={compressDialogState}
        onOpenChange={(open) => {
          if (!open) {
            setCompressState(null);
          }
        }}
        onFormatChange={(format: ArchiveFormat) =>
          setCompressState((prev) => (prev === null ? prev : { ...prev, format }))
        }
        onNameChange={(name) =>
          setCompressState((prev) => (prev === null ? prev : { ...prev, name }))
        }
        onChangeDestination={() => setDestinationPicker({ mode: "compressDestination", paths: [] })}
        onSubmit={handleCompressSubmit}
      />
      <TagsEditDialog
        open={tagsEditorEntries !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTagsEditorEntries(null);
          }
        }}
        count={tagsEditorEntries?.length ?? 0}
        tags={tags}
        checkState={(tagId) =>
          computeTagCheckState(
            (tagsEditorEntries ?? []).map((target) => ({ tagIds: target.meta?.tagIds ?? [] })),
            tagId,
          )
        }
        onToggle={(tagId, checked) =>
          handleToggleTag(
            (tagsEditorEntries ?? []).map((target) => target.path),
            tagId,
            checked,
          )
        }
        onCreate={handleCreateTagFromEditor}
        creating={createTag.isPending}
      />
    </>
  );
}
