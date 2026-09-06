"use client";

import { parentPath } from "@fdrive/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  EyeIcon,
  RotateCcwIcon,
  SaveIcon,
  WrapTextIcon,
  XIcon,
} from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CodeMirrorEditor, type EditorResetSignal } from "@/components/editor/codemirror-editor";
import { EditorStatusBar } from "@/components/editor/editor-status-bar";
import { LeaveConfirmDialog } from "@/components/editor/leave-confirm-dialog";
import { SaveConflictDialog } from "@/components/editor/save-conflict-dialog";
import { TooLargeCard } from "@/components/editor/too-large-card";
import { type EditorLoadState, useEditorLoad } from "@/components/editor/use-editor-load";
import { usePreviewObjectUrl } from "@/components/editor/use-preview-object-url";
import { MarkdownViewer } from "@/components/preview/markdown-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { decideSave, type SaveBaseline } from "@/lib/editor/conflict";
import {
  apiClient,
  describeApiError,
  detectPlatform,
  queryKeys,
  viewHref,
} from "@/lib/editor/deps";
import { guardBeforeUnload, isDirty } from "@/lib/editor/dirty";
import { computeDocumentStats } from "@/lib/editor/document-stats";
import { capitalize } from "@/lib/editor/format";
import { keyToEditorAction } from "@/lib/editor/keymap";
import { languageKeyFor } from "@/lib/editor/language";
import { DEFAULT_WORD_WRAP, readWordWrap, writeWordWrap } from "@/lib/editor/word-wrap";
import { previewKindFor } from "@/lib/preview/kind";

export interface EditorShellProps {
  readonly path: string;
}

interface DocumentBaseline extends SaveBaseline {
  readonly text: string;
}

/**
 * Asserts a dynamically built path is a valid Next.js route. Next's typed
 * routes can only verify string literals at compile time; paths built at
 * runtime (from `viewHref`) need this explicit (safe, since they are
 * always same-origin app paths) cast.
 */
function toRoute(href: string): Route {
  return href as Route;
}

type NarrowTab = "edit" | "preview";

function LoadingState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <Skeleton className="h-48 w-full max-w-md" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

function ErrorState({ backHref }: { backHref: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="max-w-sm">
        <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
          <XIcon className="size-8 text-destructive" />
          <CardTitle>Could not load this file</CardTitle>
          <Button render={<a href={backHref} />} nativeButton={false}>
            Back to preview
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The in-place editor's client shell: loads the entry and its text, tracks
 * an editable document and its dirty/conflict state, and renders the
 * CodeMirror editor (optionally split with a live markdown preview). All
 * decision logic (conflict detection, dirtiness, key shortcuts, document
 * stats, language selection) lives in `lib/editor` and is unit tested;
 * this component only wires that logic to state and the DOM.
 */
export function EditorShell({ path }: EditorShellProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const parent = parentPath(path);
  const backHref = viewHref(path);

  const [generation, setGeneration] = useState(0);
  const loadState: EditorLoadState = useEditorLoad(path, generation);

  const [baseline, setBaseline] = useState<DocumentBaseline | null>(null);
  const [documentText, setDocumentText] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const resetTokenRef = useRef(0);
  const [resetSignal, setResetSignal] = useState<EditorResetSignal>({ text: "", token: 0 });

  const [wordWrap, setWordWrap] = useState(DEFAULT_WORD_WRAP);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [narrowTab, setNarrowTab] = useState<NarrowTab>("edit");
  const [savePending, setSavePending] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  useEffect(() => {
    setWordWrap(readWordWrap(window.localStorage));
  }, []);

  useEffect(() => {
    if (loadState.status !== "ready") {
      return;
    }
    resetTokenRef.current += 1;
    setBaseline({
      modifiedAt: loadState.entry.modifiedAt,
      size: loadState.entry.size,
      text: loadState.text,
    });
    setDocumentText(loadState.text);
    setResetSignal({ text: loadState.text, token: resetTokenRef.current });
  }, [loadState]);

  const dirty = baseline !== null && isDirty(baseline.text, documentText);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      guardBeforeUnload(event, dirty);
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const entry =
    loadState.status === "ready" || loadState.status === "too-large" ? loadState.entry : undefined;
  const kind = entry !== undefined ? previewKindFor(entry) : undefined;
  const isMarkdown = kind === "markdown";
  const languageKey = entry !== undefined ? languageKeyFor(entry.ext) : "none";

  async function performSave() {
    if (baseline === null) {
      return;
    }
    setSavePending(true);
    try {
      const blob = new Blob([documentText], { type: "text/plain;charset=utf-8" });
      const saved = await apiClient.upload(path, blob, {
        modifiedAt: new Date(),
        contentLength: blob.size,
      });
      setBaseline({ modifiedAt: saved.modifiedAt, size: saved.size, text: documentText });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fs.list(parent) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fs.stat(path) });
      toast.success("Saved");
      setConflictOpen(false);
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setSavePending(false);
    }
  }

  async function handleSaveClick() {
    if (baseline === null || savePending) {
      return;
    }
    try {
      const current = await apiClient.stat(path);
      const decision = decideSave(baseline, { modifiedAt: current.modifiedAt, size: current.size });
      if (decision === "conflict") {
        setConflictOpen(true);
        return;
      }
      await performSave();
    } catch (err) {
      toast.error(describeApiError(err));
    }
  }

  function handleReloadFromConflict() {
    setConflictOpen(false);
    setGeneration((value) => value + 1);
  }

  function handleDiscard() {
    if (baseline === null) {
      return;
    }
    resetTokenRef.current += 1;
    setDocumentText(baseline.text);
    setResetSignal({ text: baseline.text, token: resetTokenRef.current });
  }

  function handleBackClick() {
    if (dirty) {
      setLeaveConfirmOpen(true);
      return;
    }
    router.push(toRoute(backHref));
  }

  function handleConfirmLeave() {
    setLeaveConfirmOpen(false);
    router.push(toRoute(backHref));
  }

  function toggleWordWrap() {
    setWordWrap((previous) => {
      const next = !previous;
      writeWordWrap(window.localStorage, next);
      return next;
    });
  }

  const handleSaveClickRef = useRef(handleSaveClick);
  handleSaveClickRef.current = handleSaveClick;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const platform = detectPlatform(typeof navigator === "undefined" ? undefined : navigator);
      const action = keyToEditorAction(event, platform);
      if (action === "save") {
        event.preventDefault();
        void handleSaveClickRef.current();
      } else if (action === "togglePreview" && isMarkdown) {
        event.preventDefault();
        setPreviewOpen((previous) => !previous);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMarkdown]);

  const stats = computeDocumentStats(documentText, cursorOffset);
  const previewUrl = usePreviewObjectUrl(documentText, 400);

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm supports-backdrop-filter:bg-background/60">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" onClick={handleBackClick} />}
            >
              <ChevronLeftIcon />
              <span className="sr-only">Back to preview</span>
            </TooltipTrigger>
            <TooltipContent>Back to preview</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-5" />

          <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
            {entry?.name ?? "Loading…"}
            {dirty && (
              <span
                role="status"
                aria-label="Unsaved changes"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
          </span>

          {kind !== undefined && <Badge variant="secondary">{capitalize(kind)}</Badge>}

          <div className="flex flex-1 items-center justify-end gap-1">
            {isMarkdown && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={previewOpen ? "secondary" : "ghost"}
                      size="icon-sm"
                      onClick={() => setPreviewOpen((previous) => !previous)}
                    />
                  }
                >
                  <EyeIcon />
                  <span className="sr-only">Preview</span>
                </TooltipTrigger>
                <TooltipContent>
                  Preview
                  <Kbd>⇧⌘P</Kbd>
                </TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={wordWrap ? "secondary" : "ghost"}
                    size="icon-sm"
                    onClick={toggleWordWrap}
                  />
                }
              >
                <WrapTextIcon />
                <span className="sr-only">Word wrap</span>
              </TooltipTrigger>
              <TooltipContent>Word wrap</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!dirty}
                    onClick={handleDiscard}
                  />
                }
              >
                <RotateCcwIcon />
                <span className="sr-only">Discard changes</span>
              </TooltipTrigger>
              <TooltipContent>Discard changes</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    disabled={baseline === null || savePending}
                    onClick={() => void handleSaveClick()}
                  />
                }
              >
                <SaveIcon />
                Save
              </TooltipTrigger>
              <TooltipContent>
                Save
                <Kbd>⌘S</Kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          {loadState.status === "loading" && <LoadingState />}
          {loadState.status === "error" && <ErrorState backHref={backHref} />}
          {loadState.status === "too-large" && (
            <TooLargeCard name={loadState.entry.name} downloadUrl={apiClient.downloadUrl(path)} />
          )}
          {loadState.status === "ready" &&
            baseline !== null &&
            (isMarkdown && previewOpen ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <Tabs
                  value={narrowTab}
                  onValueChange={(value) => setNarrowTab(value as NarrowTab)}
                  className="shrink-0 border-b px-3 py-1.5 lg:hidden"
                >
                  <TabsList>
                    <TabsTrigger value="edit">Edit</TabsTrigger>
                    <TabsTrigger value="preview">Preview</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="flex min-h-0 flex-1">
                  <div
                    className={
                      narrowTab === "preview"
                        ? "hidden min-h-0 min-w-0 flex-1 lg:flex"
                        : "flex min-h-0 min-w-0 flex-1"
                    }
                  >
                    <CodeMirrorEditor
                      className="h-full w-full"
                      resetSignal={resetSignal}
                      languageKey={languageKey}
                      wordWrap={wordWrap}
                      onChange={setDocumentText}
                      onCursorChange={setCursorOffset}
                    />
                  </div>
                  <div
                    className={
                      narrowTab === "edit"
                        ? "hidden min-h-0 min-w-0 flex-1 overflow-auto border-l lg:flex"
                        : "flex min-h-0 min-w-0 flex-1 overflow-auto border-l"
                    }
                  >
                    <MarkdownViewer url={previewUrl} />
                  </div>
                </div>
              </div>
            ) : (
              <CodeMirrorEditor
                className="h-full min-h-0 flex-1"
                resetSignal={resetSignal}
                languageKey={languageKey}
                wordWrap={wordWrap}
                onChange={setDocumentText}
                onCursorChange={setCursorOffset}
              />
            ))}
        </div>

        {loadState.status === "ready" && <EditorStatusBar stats={stats} />}
      </div>

      <SaveConflictDialog
        open={conflictOpen}
        onOpenChange={setConflictOpen}
        onOverwrite={() => void performSave()}
        onReload={handleReloadFromConflict}
        pending={savePending}
      />
      <LeaveConfirmDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        onConfirm={handleConfirmLeave}
      />
    </TooltipProvider>
  );
}
