"use client";

import { Download, LockIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { UnlockForm } from "@/components/encryption/unlock-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchDecrypted } from "@/lib/encryption/content";
import type { EncryptedView, ShownEntry } from "@/lib/encryption/listing";
import type { DecryptedFile } from "@/lib/encryption/use-decrypted-file";
import { useFormatters } from "@/lib/use-format-preferences";
import { PreviewViewer } from "./preview-viewer";

export interface EncryptedPreviewProps {
  readonly view: EncryptedView;
  /** The file, with its decrypted name; undefined until its folder opens. */
  readonly entry: ShownEntry | undefined;
  readonly decrypted: DecryptedFile;
  readonly downloadUrl: string;
  readonly folderEntries: readonly ShownEntry[] | undefined;
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-sm text-center">
        <CardHeader className="items-center">
          <LockIcon className="mx-auto mb-2 size-10 text-muted-foreground" strokeWidth={1.5} />
          <CardTitle className="break-all">{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">{children}</CardContent>
      </Card>
    </div>
  );
}

/** A file of an encrypted folder too large to preview, downloaded decrypted on request. */
function TooLarge({
  entry,
  downloadable,
  downloadUrl,
  identity,
}: {
  entry: ShownEntry;
  downloadable: boolean;
  downloadUrl: string;
  identity: string;
}) {
  const { formatBytes } = useFormatters();
  const [pending, setPending] = useState(false);
  async function download() {
    setPending(true);
    try {
      const blob = await fetchDecrypted(downloadUrl, identity, entry.mime ?? "");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      toast.error(`Could not download ${entry.name}.`);
    } finally {
      setPending(false);
    }
  }
  return (
    <Message title={entry.name}>
      <CardDescription>{formatBytes(entry.size)}</CardDescription>
      <p className="text-sm text-muted-foreground">
        {downloadable
          ? "This file is too large to preview. Download it to open it."
          : "This file is too large to open in the browser. Open it in FDrive for Mac."}
      </p>
      {downloadable && (
        <Button disabled={pending} onClick={() => void download()}>
          <Download data-icon="inline-start" />
          {pending ? "Decrypting…" : "Download"}
        </Button>
      )}
    </Message>
  );
}

/** What the preview page shows for a file of an encrypted folder. */
export function EncryptedPreview({
  view,
  entry,
  decrypted,
  downloadUrl,
  folderEntries,
}: EncryptedPreviewProps) {
  if (view.kind === "locked") {
    return (
      <div className="flex h-full items-start justify-center p-6">
        <UnlockForm className="w-full max-w-md" />
      </div>
    );
  }
  if (view.kind === "broken") {
    return (
      <Message title="This folder does not open">
        <p className="text-sm text-muted-foreground">
          This encrypted folder&apos;s keys do not open with your key.
        </p>
      </Message>
    );
  }
  if (view.kind === "open" && entry !== undefined && entry.stray) {
    return (
      <Message title={entry.name}>
        <p className="text-sm text-muted-foreground">
          This file is not encrypted with this folder&apos;s key, so it cannot be opened here.
        </p>
      </Message>
    );
  }
  if (view.kind === "open" && entry !== undefined && decrypted.status === "too-large") {
    return (
      <TooLarge
        entry={entry}
        downloadable={decrypted.downloadable}
        downloadUrl={downloadUrl}
        identity={view.folder.identity}
      />
    );
  }
  if (decrypted.status === "error") {
    return (
      <Message title="Could not decrypt this file">
        <p className="text-sm text-muted-foreground">{decrypted.message}</p>
      </Message>
    );
  }
  if (entry !== undefined && decrypted.status === "ready") {
    return (
      <PreviewViewer
        entry={entry}
        inlineUrl={decrypted.url}
        downloadUrl={decrypted.url}
        folderEntries={folderEntries}
        encrypted
      />
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <Skeleton className="size-48" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}
