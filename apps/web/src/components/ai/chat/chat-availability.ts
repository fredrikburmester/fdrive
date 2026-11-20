"use client";

import { usePathname } from "next/navigation";
import { useAiStatus } from "@/lib/ai/queries";
import { useEncryptedFolder } from "@/lib/encryption/queries";
import { pathFromFilesPathname } from "@/lib/files/path-url";

/**
 * The folder in view, which the assistant may use; `null` on pages that are
 * not a folder, where chat is not offered.
 */
export function useChatFolder(): string | null {
  return pathFromFilesPathname(usePathname());
}

/**
 * The folder chat can work in right now, or `null` when chat is not offered:
 * AI chat is not set up, the page is not a folder, or the folder is
 * encrypted, since the assistant never sees inside one. The toolbar button
 * and the panel both ask here, so they appear and disappear together.
 */
export function useChatAvailability(): string | null {
  const { data: aiStatus } = useAiStatus();
  const folder = useChatFolder();
  const enabled = aiStatus?.chat === true;
  const encryptedFolder = useEncryptedFolder(enabled ? folder : null);
  return enabled && encryptedFolder.data === null ? folder : null;
}
