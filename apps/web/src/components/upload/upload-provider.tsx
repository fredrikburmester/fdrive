"use client";

import { createContext, type ReactNode, useContext } from "react";
import { ActivityPanel } from "@/components/activity/activity-panel";
import { ConflictDialog } from "./conflict-dialog";
import { type UseUploadFilesResult, useUploadFiles } from "./use-upload-files";

const UploadFilesContext = createContext<UseUploadFilesResult | null>(null);

/**
 * Mounts the app's single upload UI once: the floating `ActivityPanel`
 * (uploads and compress/extract jobs, see `components/activity/activity-panel.tsx`)
 * and the `ConflictDialog`. Also exposes the `useUploadFiles` result
 * (`uploadFiles`, `conflictDialog`) to every descendant via
 * `useUploadFilesContext`, so any page that can start an upload (currently
 * just the file browser) shares the exact conflict-resolution state shown
 * by the dialog mounted here, instead of each holding its own.
 */
export function UploadFilesProvider({ children }: { children: ReactNode }) {
  const uploadFiles = useUploadFiles();

  return (
    <UploadFilesContext.Provider value={uploadFiles}>
      {children}
      <ActivityPanel />
      <ConflictDialog {...uploadFiles.conflictDialog} />
    </UploadFilesContext.Provider>
  );
}

/** The shared `useUploadFiles` result mounted by `UploadFilesProvider`. */
export function useUploadFilesContext(): UseUploadFilesResult {
  const context = useContext(UploadFilesContext);
  if (context === null) {
    throw new Error("useUploadFilesContext must be used within an UploadFilesProvider");
  }
  return context;
}
