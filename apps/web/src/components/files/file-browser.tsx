"use client";

import type {
  ArchiveFormat,
  CompressRequest,
  ExtractRequest,
  FsEntry,
  ReceivedGrant,
} from "@fdrive/contracts";
import { baseName, isRoot, joinPath, parentPath } from "@fdrive/core";
import { useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { OrganizeActivity } from "@/components/ai/organize-activity";
import { OrganizeSheet } from "@/components/ai/organize-sheet";
import { NewFileDialog } from "@/components/editor/new-file-dialog";
import { UnlockForm } from "@/components/encryption/unlock-form";
import { useUploadReveal } from "@/components/files/use-upload-reveal";
import { LeaveSharedFolderDialog } from "@/components/grants/leave-shared-folder-dialog";
import { ShareWithPeopleDialog } from "@/components/grants/share-with-people-dialog";
import { Inspector } from "@/components/inspector/inspector";
import { TagsEditDialog } from "@/components/metadata/tags-edit-dialog";
import { NewOfficeDocumentDialog } from "@/components/office/new-document-dialog";
import { ShareDialog } from "@/components/shares/share-dialog";
import { Button } from "@/components/ui/button";
import { DropOverlay, useExternalDrop } from "@/components/upload/drop-overlay";
import { useUploadFilesContext } from "@/components/upload/upload-provider";
import { activityGesture } from "@/lib/activity/gestures";
import { addToChat } from "@/lib/ai/chat-panel";
import { itemCount, type MoveOutcome, summarizeMoves, undoMoves } from "@/lib/ai/organize";
import { useAiStatus, useMoveMany } from "@/lib/ai/queries";
import { useOrganize } from "@/lib/ai/use-organize";
import { useMe } from "@/lib/api/auth-queries";
import { describeApiError } from "@/lib/api/errors";
import { officeStatusQueryOptions, useOfficeStatus } from "@/lib/api/office-queries";
import type { NewFileKind } from "@/lib/editor/new-file";
import { editHref } from "@/lib/editor/route";
import { useEncryptedView } from "@/lib/encryption/listing";
import { defaultArchiveName, extractDestinationUnder } from "@/lib/files/archive";
import { takeFileClipboard, writeFileClipboard } from "@/lib/files/clipboard";
import { apiClient, PageHeader, queryKeys } from "@/lib/files/deps";
import {
  type AnchorDownloader,
  adaptDocument,
  createAnchorDownloader,
  downloadEntries,
  downloadObjectUrl,
} from "@/lib/files/download";
import { buildDownloadDeps } from "@/lib/files/download-deps";
import { useFolderView } from "@/lib/files/folder-view-queries";
import { readInspectorOpen, writeInspectorOpen } from "@/lib/files/inspector-visibility";
import { keyToAction } from "@/lib/files/keyboard";
import { isLink } from "@/lib/files/links";
import {
  DEFAULT_SHOW_THUMBNAILS,
  readShowThumbnails,
  writeShowThumbnails,
} from "@/lib/files/list-thumbnails";
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
  useRename,
  useTreeChildren,
} from "@/lib/files/queries";
import {
  cleanupSelectParam,
  parseSelectParam,
  type ScrollRequest,
  shouldPerformReveal,
} from "@/lib/files/reveal";
import { resolveRowClick } from "@/lib/files/row-click";
import {
  contextEntries,
  EMPTY_SELECTION,
  type SelectionAction,
  type SelectionState,
  selectionOf,
  selectionReducer,
} from "@/lib/files/selection";
import { sortListing } from "@/lib/files/sorting";
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
import { latestTrashIds, offerUndo, undoLatest } from "@/lib/files/undo";
import { useGridSize } from "@/lib/files/use-grid-size";
import { useListDensity } from "@/lib/files/use-list-density";
import { useRowClickAction } from "@/lib/files/use-row-click";
import {
  dropBlock,
  entryRestrictions,
  firstLockedReason,
  folderWriteBlock,
  goesToOwnTrash,
} from "@/lib/grants/paths";
import { useReceivedGrants } from "@/lib/grants/queries";
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
import { isOfficePreviewCandidate, officeModesFor, opensInOffice } from "@/lib/office/capabilities";
import type { OfficeDocumentKind } from "@/lib/office/new-document";
import { officeHref } from "@/lib/office/route";
import { isRestoreConflict, useTrashRestore } from "@/lib/trash/queries";
import { collectInputFiles } from "@/lib/upload/traverse";
import { BatchRenameDialog } from "./batch-rename-dialog";
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
import { FilesBreadcrumb, FilesToolbarActions, type FolderViewActions } from "./toolbar";
import { LOCKED_MESSAGE, useEncryptedActions } from "./use-encrypted-actions";

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
  const { data: me } = useMe();
  const { data: officeStatus } = useOfficeStatus();
  const { data: aiStatus } = useAiStatus();
  const organizeAvailable = aiStatus?.organize === true;
  const chatAvailable = aiStatus?.chat === true;
  const organize = useOrganize();
  const [officeKind, setOfficeKind] = useState<OfficeDocumentKind | null>(null);
  const [officePending, setOfficePending] = useState(false);
  const [officeError, setOfficeError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const selectName = parseSelectParam(searchParams.toString());
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching, isError, error, refetch } = useListing(path);
  const listedEntries = useMemo(() => data?.entries ?? [], [data]);
  // Inside an encrypted folder the listing shows decrypted names once this browser has the key.
  const encryptedView = useEncryptedView(path, data?.encryptedFolder, listedEntries);
  const entries = useMemo(
    () =>
      encryptedView.kind === "open"
        ? encryptedView.entries
        : encryptedView.kind === "plain"
          ? listedEntries
          : [],
    [encryptedView, listedEntries],
  );
  const encrypted = useEncryptedActions(encryptedView, path, entries, {
    save: (blob, name) =>
      downloadObjectUrl(
        URL.createObjectURL(blob),
        name,
        buildDownloadDeps(getAnchorDownloader(), apiClient),
      ),
  });
  // Before `me` loads, the folder counts as indexed, so thumbnails never flicker.
  const indexed = me?.index !== false;
  // Folders others share with this login: what they allow, and the
  // `Shared with me` captions and menu items.
  const received = useReceivedGrants();
  const writeBlock = folderWriteBlock(path, received) ?? encrypted.uploadBlock;
  // The server makes no thumbnails of what it cannot read.
  const thumbnailsHere = indexed && !encrypted.inside;

  const folderView = useFolderView(path);
  const [rowClickAction] = useRowClickAction();
  const [density, setDensity] = useListDensity();
  const [gridSize, setGridSize] = useGridSize();
  // The tree lists folders below without their keys, so an encrypted folder shows as a list.
  const viewMode = encrypted.inside && folderView.mode === "tree" ? "list" : folderView.mode;
  const setViewMode = folderView.setMode;
  const sortSpec = folderView.sort;
  const setSortSpec = folderView.setSort;
  const folderSort: FolderViewActions = {
    pinned: folderView.sortPinned,
    disabled: folderView.disabled,
    error: folderView.error,
    retry: folderView.retry,
    useDefault: folderView.useDefaultSort,
    makeDefault: folderView.makeDefaultSort,
  };
  const [showThumbnails, setShowThumbnailsState] = useState<boolean>(() =>
    typeof window === "undefined"
      ? DEFAULT_SHOW_THUMBNAILS
      : readShowThumbnails(window.localStorage),
  );
  const [treeState, setTreeStateRaw] = useState<TreeState>(EMPTY_TREE_STATE);
  useEffect(() => {
    setShowThumbnailsState(readShowThumbnails(window.localStorage));
    setTreeStateRaw(readTreeState(window.localStorage));
  }, []);
  function setShowThumbnails(show: boolean) {
    setShowThumbnailsState(show);
    writeShowThumbnails(window.localStorage, show);
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
  // What selection, select-all, the arrow keys and type-ahead move through: a link is shown,
  // never selected.
  const selectableEntries = useMemo(
    () => displayEntries.filter((entry) => !isLink(entry)),
    [displayEntries],
  );
  const orderedPaths = useMemo(
    () => selectableEntries.map((entry) => entry.path),
    [selectableEntries],
  );

  const [sharing, setSharing] = useState<FsEntry[] | null>(null);
  const [sharingWithPeople, setSharingWithPeople] = useState<FsEntry | null>(null);
  const [leaving, setLeaving] = useState<ReceivedGrant | null>(null);
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
  const moveMany = useMoveMany();
  const copy = useCopy();
  const remove = useDelete();
  const restore = useTrashRestore();
  const duplicate = useDuplicate();

  const tagsQuery = useTags();
  const tags = tagsQuery.data ?? [];
  const setFileTags = useSetFileTags();
  const toggleFavorite = useToggleFavorite();
  const { createTag } = useTagMutations();
  const [tagsEditorEntries, setTagsEditorEntries] = useState<FsEntry[] | null>(null);
  const liveTagsEditorEntries = (tagsEditorEntries ?? []).flatMap((target) => {
    const live = displayEntries.find((entry) => entry.path === target.path);
    return live ? [live] : [];
  });

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newEncryptedFolderOpen, setNewEncryptedFolderOpen] = useState(false);
  const [encryptedFolderPending, setEncryptedFolderPending] = useState(false);
  const [newFileKind, setNewFileKind] = useState<NewFileKind | null>(null);
  const [newFilePending, setNewFilePending] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null);
  const [batchRenameTargets, setBatchRenameTargets] = useState<FsEntry[] | null>(null);
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
    if (writeBlock !== null) {
      toast.error(writeBlock);
      return;
    }
    uploadFiles(files, path, existingNames, encrypted.prepareUploads);
  });
  const pasteRef = useRef(handlePaste);
  pasteRef.current = handlePaste;
  useEffect(() => {
    const listener = (event: ClipboardEvent) => pasteRef.current(event);
    document.addEventListener("paste", listener);
    return () => document.removeEventListener("paste", listener);
  }, []);

  // The page title the server rendered names the stored folder; show the decrypted one.
  useEffect(() => {
    if (encryptedView.kind !== "open") return;
    const name = encryptedView.crumbs.get(path);
    if (name !== undefined) document.title = `${name} · fdrive`;
  }, [encryptedView, path]);

  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  const scrollTokenRef = useRef(0);
  const lastRevealedRef = useRef<string | null>(null);

  const handleScrollConsumed = useCallback((token: number) => {
    setScrollRequest((current) => (current?.token === token ? null : current));
  }, []);

  const revealUploads = useCallback((paths: string[]) => {
    const targetPath = paths.at(-1);
    if (!targetPath) return;
    dispatchSelection({ type: "set", paths });
    scrollTokenRef.current += 1;
    setScrollRequest({ path: targetPath, token: scrollTokenRef.current });
  }, []);
  useUploadReveal(path, orderedPaths, { data, isFetching }, revealUploads);

  // "Reveal in folder" (from the search panel): once this folder's listing
  // has loaded and contains the named item, select it, scroll it into
  // view with the virtualizer, and clean up the `select` param so a reload
  // does not re-select it while retaining the selection in state.
  useEffect(() => {
    if (selectName === null) {
      lastRevealedRef.current = null;
      return;
    }
    if (isLoading) {
      return;
    }
    const targetPath = joinPath(path, selectName);
    if (!shouldPerformReveal(targetPath, orderedPaths, lastRevealedRef.current)) {
      return;
    }
    lastRevealedRef.current = targetPath;
    void activityGesture("file.reveal", targetPath)().catch(() => undefined);
    dispatchSelection({ type: "set", paths: [targetPath] });
    scrollTokenRef.current += 1;
    setScrollRequest({ path: targetPath, token: scrollTokenRef.current });
    const cleanSearch = cleanupSelectParam(searchParams.toString());
    const cleanHref = `${pathToHref(path)}${cleanSearch}`;
    router.replace(toRoute(cleanHref));
  }, [selectName, isLoading, orderedPaths, path, searchParams, router]);

  /** Downloads `targets`: one file directly, anything else as one zip. */
  function runDownload(targets: readonly FsEntry[]) {
    // An encrypted folder's files are decrypted here, one at a time; the server cannot zip them.
    if (encrypted.inside) {
      void encrypted.download(targets);
      return;
    }
    downloadEntries(targets, buildDownloadDeps(getAnchorDownloader(), apiClient)).catch(() =>
      toast.error("Could not download the selection."),
    );
  }

  function handleDownloadSelection() {
    runDownload(selectedEntries);
  }

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

  async function handleOpen(entry: FsEntry) {
    if (onOpen) {
      onOpen(entry);
      return;
    }
    let availableOffice = officeStatus;
    if (me && availableOffice === undefined && isOfficePreviewCandidate(entry)) {
      try {
        availableOffice = await queryClient.fetchQuery(officeStatusQueryOptions());
      } catch {
        availableOffice = undefined;
      }
    }
    if (me && !encrypted.inside && opensInOffice(entry, availableOffice)) {
      router.push(toRoute(officeHref(entry.path, "view")));
      return;
    }
    router.push(toRoute(entry.kind === "dir" ? pathToHref(entry.path) : viewHref(entry.path)));
  }

  function handleEntryClick(entry: FsEntry, modifiers: ClickModifierKeys) {
    const intent = resolveRowClick(rowClickAction, modifiers);
    if (intent.kind === "open") {
      void handleOpen(entry);
      return;
    }
    if (intent.kind === "focus") {
      dispatchSelection({ type: "focus", path: entry.path });
      return;
    }
    dispatchSelection({ type: "click", path: entry.path, modifiers: intent.modifiers });
  }

  /** Double-click opens unless a plain click already does, so one open never fires three times. */
  function handleEntryDoubleClick(entry: FsEntry) {
    if (rowClickAction !== "open") {
      void handleOpen(entry);
    }
  }

  function handleInternalDrop(paths: string[], targetFolderPath: string, effect: "move" | "copy") {
    const block = dropBlock(paths, targetFolderPath, effect, received);
    if (block !== null) {
      toast.error(block);
      return;
    }
    const sources = movablePaths(paths, targetFolderPath);
    void moveOrCopy(sources, targetFolderPath, effect);
  }

  /**
   * Moves or copies `sources` into `folder`: through the browser when that crosses an encrypted
   * folder's edge, re-encrypting each file, and with one request otherwise.
   */
  async function moveOrCopy(sources: readonly string[], folder: string, effect: "move" | "copy") {
    if (await encrypted.transfer(sources, folder, effect === "move")) return;
    if (effect === "move") {
      await moveInto(sources, folder);
      return;
    }
    for (const source of sources) {
      copy.mutate({ path: source, target: joinPath(folder, baseName(source)) });
    }
  }

  /** Moves `sources` into `folder` in one request; the toast offers to move them back. */
  async function moveInto(sources: readonly string[], folder: string) {
    if (sources.length === 0) return;
    const items = sources.map((source) => ({
      path: source,
      target: joinPath(folder, baseName(source)),
    }));
    try {
      const outcome = summarizeMoves((await moveMany.mutateAsync({ items })).results);
      for (const failure of outcome.failed) toast.error(failure.message);
      if (outcome.moved.length > 0)
        offerUndo(`Moved ${itemCount(outcome.moved.length)}`, () => moveBack(outcome.moved));
    } catch (error) {
      toast.error(describeFsError(error, "Could not move."));
    }
  }

  async function moveBack(moved: MoveOutcome["moved"]) {
    const request = undoMoves(moved);
    if (request === null) return;
    try {
      const outcome = summarizeMoves((await moveMany.mutateAsync(request)).results);
      if (outcome.failed.length > 0)
        toast.error(`Could not move ${itemCount(outcome.failed.length)} back.`);
    } catch (error) {
      toast.error(describeFsError(error, "Could not move back."));
    }
  }

  async function restoreFromTrash(paths: readonly string[]) {
    try {
      const { entries } = await apiClient.trashList();
      await restore.mutateAsync({ ids: latestTrashIds(entries, paths) });
    } catch (error) {
      // The restore reports every failure but a conflict itself.
      if (isRestoreConflict(error)) toast.error(describeFsError(error, "Could not restore."));
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
      case "share":
        setSharing(entriesForAction(entry));
        return;
      case "shareWithPeople":
        setSharingWithPeople(entry);
        return;
      case "leave":
        setLeaving(entryRestrictions(entry, received).leave);
        return;
      case "office:view":
      case "office:edit":
      case "office:convert": {
        const mode =
          action === "office:view" ? "view" : action === "office:edit" ? "edit" : "convert";
        if (
          me &&
          officeModesFor(entry, officeStatus, entriesForAction(entry).length).includes(mode)
        )
          router.push(toRoute(officeHref(entry.path, mode)));
        break;
      }
      case "open":
        handleOpen(entry);
        break;
      case "download":
        runDownload(entriesForAction(entry));
        break;
      case "rename":
        startRename(entriesForAction(entry));
        break;
      case "moveTo":
        setDestinationPicker({ mode: "move", paths: pathsForAction(entry) });
        break;
      case "copyTo":
        setDestinationPicker({ mode: "copy", paths: pathsForAction(entry) });
        break;
      case "organize":
        if (organizeAvailable) organize.open(entriesForAction(entry));
        break;
      case "addToChat":
        if (chatAvailable) addToChat(entriesForAction(entry).map((item) => item.path));
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

  async function handleCreateFolder(name: string) {
    let stored: string;
    try {
      stored = await encrypted.nameFor(name);
    } catch (err) {
      toast.error(describeFsError(err, "Could not name the folder."));
      return;
    }
    mkdir.mutate(joinPath(path, stored), {
      onSuccess: (entry) => {
        setNewFolderOpen(false);
        dispatchSelection({ type: "set", paths: [entry.path] });
      },
    });
  }

  async function handleCreateEncryptedFolder(name: string) {
    setEncryptedFolderPending(true);
    try {
      const created = await encrypted.createEncryptedFolder(name);
      setNewEncryptedFolderOpen(false);
      dispatchSelection({ type: "set", paths: [created] });
    } catch (err) {
      toast.error(describeFsError(err, "Could not make the encrypted folder."));
    } finally {
      setEncryptedFolderPending(false);
    }
  }

  async function handleCreateFile(name: string) {
    if (newFileKind === null) {
      return;
    }
    setNewFilePending(true);
    const targetPath = joinPath(path, name);
    try {
      await apiClient.upload(targetPath, new Blob([]), { contentLength: 0, intent: "create" });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fs.list(path) });
      setNewFileKind(null);
      router.push(toRoute(editHref(targetPath)));
    } catch (err) {
      toast.error(describeFsError(err, "Could not create the file."));
    } finally {
      setNewFilePending(false);
    }
  }

  async function handleCreateOfficeDocument(name: string) {
    if (!me || officePending) return;
    setOfficePending(true);
    setOfficeError(null);
    try {
      const created = await apiClient.officeCreateDocument({ parent: path, name });
      if (created.identityId !== me.identity.id)
        throw new Error("The document connection could not be verified.");
      void queryClient.invalidateQueries({ queryKey: queryKeys.fs.list(path) });
      setOfficeKind(null);
      router.push(toRoute(officeHref(created.path, "edit")));
    } catch (err) {
      setOfficeError(describeApiError(err));
    } finally {
      setOfficePending(false);
    }
  }

  /** Opens Rename for `targets`, the batch dialog for more than one, unless one is locked. */
  function startRename(targets: readonly FsEntry[]) {
    const lock = firstLockedReason(
      targets.map((target) => target.path),
      received,
    );
    const [only] = targets;
    if (lock !== null) toast.error(lock);
    else if (targets.length > 1) setBatchRenameTargets([...targets]);
    else if (only !== undefined) setRenameTarget(only);
  }

  async function handleRenameSubmit(newName: string) {
    const target = renameTarget;
    if (target === null) {
      return;
    }
    let stored: string;
    try {
      stored = await encrypted.nameFor(newName);
    } catch (err) {
      toast.error(describeFsError(err, "Could not rename."));
      return;
    }
    rename.mutate(
      { path: target.path, newName: stored },
      {
        onSuccess: (renamed) => {
          setRenameTarget(null);
          offerUndo(`Renamed to "${newName}"`, () =>
            rename.mutateAsync({ path: renamed.path, newName: encrypted.storedName(target) }),
          );
        },
      },
    );
  }

  /** Renames for the batch dialog, under encrypted names inside an encrypted folder. */
  async function renameOne(vars: { path: string; newName: string }) {
    return rename.mutateAsync({ ...vars, newName: await encrypted.nameFor(vars.newName) });
  }

  function handleDeleteConfirm() {
    const paths = deleteTargets.map((entry) => entry.path);
    remove.mutate(
      deleteTargets.map((entry) => ({ path: entry.path, kind: deleteItemKind(entry) })),
      {
        onSuccess: () => {
          setDeleteTargets([]);
          const message = `Moved ${itemCount(paths.length)} to Trash`;
          // Undo restores from the login's own Trash; an item in a folder shared
          // with it went to its owner's, which only the owner restores from.
          if (goesToOwnTrash(paths, received)) offerUndo(message, () => restoreFromTrash(paths));
          else toast.success(message);
        },
      },
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

    if (
      movablePaths(destinationPicker.paths, destinationDir).length !==
      destinationPicker.paths.length
    ) {
      return;
    }
    void moveOrCopy(
      destinationPicker.paths,
      destinationDir,
      destinationPicker.mode === "move" ? "move" : "copy",
    );
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
    uploadFiles(collectInputFiles(collected), path, existingNames, encrypted.prepareUploads);
  }

  /**
   * Pastes into this folder from anywhere on the page but a text field: files on the system
   * clipboard upload, otherwise what ⌘C or ⌘X put on fdrive's own clipboard is copied or moved.
   */
  function handlePaste(event: ClipboardEvent) {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea, select") !== null)
    ) {
      return;
    }
    const files = collectInputFiles(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      if (writeBlock !== null) toast.error(writeBlock);
      else uploadFiles(files, path, existingNames, encrypted.prepareUploads);
      return;
    }
    const clipboard = takeFileClipboard();
    if (clipboard !== null) {
      handleInternalDrop([...clipboard.paths], path, clipboard.mode === "cut" ? "move" : "copy");
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (
      event.defaultPrevented ||
      target.closest(
        'input, textarea, select, button, a, [contenteditable="true"], [role="checkbox"], [role="switch"], [role="button"], [role="menuitem"]',
      )
    ) {
      return;
    }

    if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const buffer = nextTypeAheadBuffer(typeAheadRef.current, event.key, Date.now());
      typeAheadRef.current = buffer;
      const currentIndex = selection.focus === null ? -1 : orderedPaths.indexOf(selection.focus);
      const matchIndex = typeAheadMatch(
        selectableEntries.map((entry) => entry.name),
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
      case "delete": {
        const lock = firstLockedReason(
          selectedEntries.map((entry) => entry.path),
          received,
        );
        if (lock !== null) {
          toast.error(lock);
        } else if (selectedEntries.length > 0) {
          setDeleteTargets(selectedEntries);
        }
        break;
      }
      case "selectAll":
        dispatchSelection({ type: "selectAll" });
        break;
      case "copy":
      case "cut":
        if (selectedEntries.length > 0) {
          writeFileClipboard({
            mode: action.type,
            paths: selectedEntries.map((entry) => entry.path),
          });
        }
        break;
      case "undo":
        void undoLatest();
        break;
      case "clear":
        dispatchSelection({ type: "clear" });
        break;
      case "rename": {
        const entry = displayEntries.find((candidate) => candidate.path === selection.focus);
        startRename(selectedEntries.length > 1 ? selectedEntries : entry ? [entry] : []);
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
        handleDownloadSelection();
        break;
      }
      case "newFolder":
        if (writeBlock !== null) toast.error(writeBlock);
        else setNewFolderOpen(true);
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
        breadcrumbs={
          <FilesBreadcrumb
            path={path}
            onInternalDrop={handleInternalDrop}
            names={encryptedView.kind === "open" ? encryptedView.crumbs : undefined}
          />
        }
        actions={
          <FilesToolbarActions
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            folderView={folderView}
            sortSpec={sortSpec}
            onSortSpecChange={setSortSpec}
            folderSort={folderSort}
            density={density}
            onDensityChange={setDensity}
            gridSize={gridSize}
            onGridSizeChange={setGridSize}
            onNewFolder={() => setNewFolderOpen(true)}
            onNewEncryptedFolder={
              me?.encryptedFolders && !encrypted.inside && !path.startsWith("/Shared with me")
                ? () => setNewEncryptedFolderOpen(true)
                : undefined
            }
            encrypted={encrypted.inside}
            onNewFile={setNewFileKind}
            onNewOfficeDocument={
              officeStatus?.available && me && !encrypted.inside
                ? (kind) => {
                    setOfficeError(null);
                    setOfficeKind(kind);
                  }
                : undefined
            }
            onUploadFiles={handleUploadFiles}
            onUploadFolder={handleUploadFolder}
            detailsOpen={detailsOpen}
            onToggleDetails={() => setDetailsOpen(!detailsOpen)}
            selection={selectionOf(selectedEntries)}
            indexed={thumbnailsHere}
            onClearSelection={() => dispatchSelection({ type: "clear" })}
            onDuplicateSelection={handleDuplicateSelection}
            onCompressSelection={handleCompressSelection}
            onOrganizeSelection={
              organizeAvailable && !encrypted.inside && selectedEntries.length > 0
                ? () => organize.open(selectedEntries)
                : undefined
            }
            onAddSelectionToChat={
              chatAvailable && !encrypted.inside && selectedEntries.length > 0
                ? () => addToChat(selectedEntries.map((item) => item.path))
                : undefined
            }
            onDownloadSelection={handleDownloadSelection}
            showThumbnails={showThumbnails && thumbnailsHere}
            onShowThumbnailsChange={setShowThumbnails}
            writeBlock={writeBlock}
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
            {isLoading || folderView.loading ? (
              <ListingSkeleton
                variant={viewMode === "grid" ? "grid" : "list"}
                density={density}
                gridSize={gridSize}
              />
            ) : isError ? (
              <ErrorState
                message={describeFsError(error, "Something went wrong.")}
                onRetry={() => refetch()}
              />
            ) : encryptedView.kind === "locked" ? (
              <div className="flex h-full items-start justify-center p-6">
                <UnlockForm className="w-full max-w-md" />
              </div>
            ) : encryptedView.kind === "opening" ? (
              <ListingSkeleton
                variant={viewMode === "grid" ? "grid" : "list"}
                density={density}
                gridSize={gridSize}
              />
            ) : encryptedView.kind === "broken" ? (
              <ErrorState message="This encrypted folder's keys do not open with your key." />
            ) : sortedEntries.length === 0 ? (
              <EmptyState
                action={
                  writeBlock === null ? (
                    <Button variant="outline" size="sm" onClick={handleUploadFiles}>
                      Upload
                    </Button>
                  ) : undefined
                }
              />
            ) : viewMode === "list" ? (
              <FileList
                density={density}
                entries={sortedEntries}
                selected={selection.selected}
                focusedPath={selection.focus}
                onEntryClick={handleEntryClick}
                onEntryDoubleClick={handleEntryDoubleClick}
                officeStatus={officeStatus}
                onContextAction={handleContextAction}
                showOrganize={organizeAvailable && !encrypted.inside}
                showChat={chatAvailable && !encrypted.inside}
                encrypted={encrypted.inside}
                hideArchive={encrypted.inside}
                getDragPaths={pathsForAction}
                onInternalDrop={handleInternalDrop}
                onToggleSelectAll={handleToggleSelectAll}
                onClearSelection={() => dispatchSelection({ type: "clear" })}
                tags={tags}
                onToggleTag={handleToggleTag}
                onOpenTagsEditor={handleOpenTagsEditor}
                onToggleFavorite={handleToggleFavorite}
                received={received}
                scrollRequest={scrollRequest}
                onScrollConsumed={handleScrollConsumed}
                showThumbnails={showThumbnails && thumbnailsHere}
              />
            ) : viewMode === "grid" ? (
              <FileGrid
                entries={sortedEntries}
                selected={selection.selected}
                focusedPath={selection.focus}
                onEntryClick={handleEntryClick}
                onEntryDoubleClick={handleEntryDoubleClick}
                officeStatus={officeStatus}
                onContextAction={handleContextAction}
                showOrganize={organizeAvailable && !encrypted.inside}
                showChat={chatAvailable && !encrypted.inside}
                encrypted={encrypted.inside}
                hideArchive={encrypted.inside}
                getDragPaths={pathsForAction}
                onInternalDrop={handleInternalDrop}
                onToggleSelectAll={handleToggleSelectAll}
                onClearSelection={() => dispatchSelection({ type: "clear" })}
                tags={tags}
                onToggleTag={handleToggleTag}
                onOpenTagsEditor={handleOpenTagsEditor}
                onToggleFavorite={handleToggleFavorite}
                received={received}
                scrollRequest={scrollRequest}
                onScrollConsumed={handleScrollConsumed}
                thumbnails={thumbnailsHere}
                size={gridSize}
              />
            ) : (
              <FileList
                density={density}
                entries={displayEntries}
                selected={selection.selected}
                focusedPath={selection.focus}
                onEntryClick={handleEntryClick}
                onEntryDoubleClick={handleEntryDoubleClick}
                officeStatus={officeStatus}
                onContextAction={handleContextAction}
                showOrganize={organizeAvailable && !encrypted.inside}
                showChat={chatAvailable && !encrypted.inside}
                encrypted={encrypted.inside}
                hideArchive={encrypted.inside}
                getDragPaths={pathsForAction}
                onInternalDrop={handleInternalDrop}
                onToggleSelectAll={handleToggleSelectAll}
                onClearSelection={() => dispatchSelection({ type: "clear" })}
                treeDepths={treeDepths}
                treeExpanded={treeState.expanded}
                onToggleTreeExpand={handleToggleTreeExpand}
                tags={tags}
                onToggleTag={handleToggleTag}
                onOpenTagsEditor={handleOpenTagsEditor}
                onToggleFavorite={handleToggleFavorite}
                received={received}
                scrollRequest={scrollRequest}
                onScrollConsumed={handleScrollConsumed}
                showThumbnails={showThumbnails && thumbnailsHere}
              />
            )}
          </div>
          <DropOverlay visible={isDraggingOver} destinationName={destinationName} />
        </div>
        {detailsOpen && (
          <Inspector
            entries={selectedEntries}
            onClose={() => setDetailsOpen(false)}
            indexed={thumbnailsHere}
          />
        )}
      </div>

      {officeKind !== null && (
        <NewOfficeDocumentDialog
          key={officeKind}
          kind={officeKind}
          pending={officePending}
          error={officeError}
          onClose={() => setOfficeKind(null)}
          onCreate={(name) => {
            void handleCreateOfficeDocument(name);
          }}
        />
      )}
      {sharing && <ShareDialog entries={sharing} onClose={() => setSharing(null)} />}
      {sharingWithPeople && (
        <ShareWithPeopleDialog
          folder={sharingWithPeople}
          onClose={() => setSharingWithPeople(null)}
        />
      )}
      <LeaveSharedFolderDialog grant={leaving} onClose={() => setLeaving(null)} />
      <OrganizeSheet
        organize={organize}
        provider={aiStatus?.provider ?? null}
        onMoved={() => dispatchSelection({ type: "clear" })}
      />
      <OrganizeActivity status={organize.status} onOpen={organize.show} />
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        onCreate={(name) => void handleCreateFolder(name)}
        pending={mkdir.isPending}
      />
      <NewFolderDialog
        open={newEncryptedFolderOpen}
        onOpenChange={setNewEncryptedFolderOpen}
        onCreate={(name) => void handleCreateEncryptedFolder(name)}
        pending={encryptedFolderPending}
        title="New encrypted folder"
        description="Names and files inside are encrypted in this browser before they upload."
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
        onRename={(name) => void handleRenameSubmit(name)}
        pending={rename.isPending}
      />
      {batchRenameTargets !== null && (
        <BatchRenameDialog
          entries={batchRenameTargets}
          siblings={displayEntries}
          onClose={() => setBatchRenameTargets(null)}
          onRename={renameOne}
        />
      )}
      <DeleteDialog
        entries={deleteTargets}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTargets([]);
          }
        }}
        onConfirm={handleDeleteConfirm}
        pending={remove.isPending}
        received={received}
      />
      {destinationPicker !== null && (
        <DestinationPicker
          open
          mode={destinationPicker.mode}
          sourcePaths={
            destinationPicker.mode === "move" || destinationPicker.mode === "copy"
              ? destinationPicker.paths
              : []
          }
          initialPath={path}
          onOpenChange={(open) => {
            if (!open) {
              setDestinationPicker(null);
            }
          }}
          onConfirm={handleDestinationConfirm}
          pending={
            destinationPicker.mode === "move"
              ? moveMany.isPending
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
        count={liveTagsEditorEntries.length}
        tags={tags}
        checkState={(tagId) =>
          computeTagCheckState(
            liveTagsEditorEntries.map((target) => ({ tagIds: target.meta?.tagIds ?? [] })),
            tagId,
          )
        }
        onToggle={(tagId, checked) =>
          handleToggleTag(
            liveTagsEditorEntries.map((target) => target.path),
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
