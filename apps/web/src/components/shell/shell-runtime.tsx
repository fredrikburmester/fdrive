"use client";

import type { ReactNode } from "react";
import { UploadFilesProvider } from "@/components/upload/upload-provider";
import { useFsEvents } from "@/lib/api/sse";

/**
 * The shell's client-only runtime, mounted once by `(shell)/layout.tsx`:
 * the live-update SSE connection (`useFsEvents`) and the single upload
 * queue UI (`UploadFilesProvider`, which itself mounts `UploadPanel` and
 * `ConflictDialog`).
 */
export function ShellRuntime({ children }: { children: ReactNode }) {
  useFsEvents();
  return <UploadFilesProvider>{children}</UploadFilesProvider>;
}
