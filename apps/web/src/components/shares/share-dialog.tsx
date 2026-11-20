"use client";

import type { FsEntry, ManagedShare } from "@fdrive/contracts";
import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ShareFormFields, useShareForm } from "./share-form";
import { copyShareLink, shareLinkUrl } from "./share-link";

/**
 * Creates a link for the files chosen in the file browser, or edits one there. The Shares page
 * edits a link in its sheet, with the same form (`share-form.tsx`).
 * Mounted only while open, so closing always discards transient password state.
 */
export function ShareDialog({
  entries,
  share,
  onClose,
}: {
  entries: readonly FsEntry[];
  share?: ManagedShare;
  onClose: () => void;
}) {
  const [created, setCreated] = useState<ManagedShare | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const form = useShareForm({
    entries,
    share,
    onSaved: (result) => {
      if (share) onClose();
      else setCreated(result);
    },
  });
  async function copyCreated() {
    if (!created) return;
    try {
      await copyShareLink(created);
      setCopyError(null);
    } catch {
      setCopyError("Could not copy the link. Select and copy it below.");
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.pending) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {created ? "Share link ready" : share ? "Edit share link" : "Create share link"}
          </DialogTitle>
          <DialogDescription>
            {created
              ? "Anyone with this link can use it under the limits you chose."
              : "Choose how people can access the selected files. Your originals stay in place."}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <Input aria-label="Share link" readOnly value={shareLinkUrl(created.id)} />
            {copyError && <FieldError>{copyError}</FieldError>}
            <DialogFooter>
              <Button variant="outline" onClick={() => void copyCreated()}>
                <Copy />
                Copy link
              </Button>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void form.submit(event)} className="space-y-5">
            <ShareFormFields form={form} layout="dialog" />
            {form.error && <FieldError>{form.error}</FieldError>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={form.pending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.pending}>
                {form.pending ? "Saving…" : share ? "Save changes" : "Create link"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
