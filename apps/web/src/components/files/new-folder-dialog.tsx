"use client";

import { isSafeSegment } from "@fdrive/core";
import { Loader2Icon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const DEFAULT_NAME = "Untitled folder";

export interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
  pending?: boolean;
}

/** Prompts for a name and creates a new folder in the current directory. */
export function NewFolderDialog({
  open,
  onOpenChange,
  onCreate,
  pending = false,
}: NewFolderDialogProps) {
  const [name, setName] = useState(DEFAULT_NAME);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (open) {
      setName(DEFAULT_NAME);
    }
  }, [open]);

  /** Selects the whole default name so typing replaces it, rather than inserting into it. */
  function focusAndSelectAll(): boolean {
    const input = inputRef.current;
    if (input === null) {
      return false;
    }
    input.focus();
    input.select();
    return false;
  }

  const trimmed = name.trim();
  const valid = isSafeSegment(trimmed);

  function handleOpenChange(next: boolean) {
    if (!pending) onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid && !pending) {
      onCreate(trimmed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent initialFocus={focusAndSelectAll} showCloseButton={!pending}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Choose a name for the new folder.</DialogDescription>
          </DialogHeader>
          <Field className="py-4">
            <Input
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Folder name"
              disabled={pending}
              aria-invalid={trimmed.length > 0 && !valid}
              aria-describedby={trimmed.length > 0 && !valid ? errorId : undefined}
            />
            {trimmed.length > 0 && !valid && (
              <p id={errorId} className="text-sm text-destructive">
                Choose a shorter folder name without /, other than . or ..
              </p>
            )}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-8"
              disabled={pending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-11 sm:h-8"
              disabled={!valid || pending}
              aria-busy={pending}
            >
              {pending && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
