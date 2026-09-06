"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed.length > 0) {
      onCreate(trimmed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={focusAndSelectAll}>
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
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0 || pending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
