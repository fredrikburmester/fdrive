"use client";

import { Upload } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { createShareUploadQueue } from "@/lib/shares/uploads";

export function PublicUpload({
  queue,
  enabled,
}: {
  queue: ReturnType<typeof createShareUploadQueue>;
  enabled: boolean;
}) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  function add(files: readonly File[]) {
    if (!enabled) return;
    try {
      queue.enqueue(files);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add these files.");
    }
  }
  return (
    <section className="space-y-4" aria-label="Upload files">
      <FieldSet
        aria-label="Drop files"
        className="rounded-xl border border-dashed bg-muted/20 p-8 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (
            Array.from(event.dataTransfer.items).some(
              (item) => item.webkitGetAsEntry?.()?.isDirectory,
            )
          ) {
            setError("Choose files individually. Folder uploads are not supported.");
            return;
          }
          add(Array.from(event.dataTransfer.files));
        }}
      >
        <Upload className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="mb-3 text-sm text-muted-foreground">
          Drop files here or choose them below. Folder uploads are not supported.
        </p>
        <Input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          aria-label="Choose files to upload"
          disabled={!enabled}
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <Button disabled={!enabled} onClick={() => input.current?.click()}>
          Choose files
        </Button>
      </FieldSet>
      {error && <FieldError>{error}</FieldError>}
      {items.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {items.map((item) => (
            <li key={item.id} className="space-y-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-medium">{item.file.name}</span>
                <span className="text-xs text-muted-foreground">
                  {item.status === "done"
                    ? "Uploaded"
                    : item.status === "uploading"
                      ? `${item.progress}%`
                      : item.status}
                </span>
              </div>
              {item.status === "uploading" && (
                <Progress value={item.progress} aria-label={`Uploading ${item.file.name}`} />
              )}
              {item.error && <FieldError>{item.error}</FieldError>}
              <div className="flex justify-end">
                {item.status === "queued" || item.status === "uploading" ? (
                  <Button variant="ghost" size="sm" onClick={() => queue.cancel(item.id)}>
                    Cancel
                  </Button>
                ) : item.status === "error" || item.status === "cancelled" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!enabled}
                    onClick={() => queue.retry(item.id)}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        This link accepts uploads only. Folder contents are private.
      </p>
    </section>
  );
}
