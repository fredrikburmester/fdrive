"use client";

import type { FsEntry } from "@fdrive/contracts";
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
import { splitNameForSelection } from "@/lib/files/naming";

export interface RenameDialogProps {
  entry: FsEntry | null;
  onOpenChange: (open: boolean) => void;
  onRename: (newName: string) => void;
  pending?: boolean;
}

/** Prompts for a new name for `entry`, pre-selecting the name without its extension. */
export function RenameDialog({
  entry,
  onOpenChange,
  onRename,
  pending = false,
}: RenameDialogProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (entry !== null) {
      setName(entry.name);
    }
  }, [entry]);

  function focusAndSelectBaseName(): boolean {
    const input = inputRef.current;
    if (input === null || entry === null) {
      return false;
    }
    const { base } = splitNameForSelection(entry.name);
    input.focus();
    input.setSelectionRange(0, base.length);
    return false;
  }

  const trimmed = name.trim();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed.length > 0) {
      onRename(trimmed);
    }
  }

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={focusAndSelectBaseName}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>Choose a new name for "{entry?.name}".</DialogDescription>
          </DialogHeader>
          <Field className="py-4">
            <Input
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="New name"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0 || pending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
