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
import { defaultFileName, type NewFileKind } from "@/lib/editor/new-file";
import { splitNameForSelection } from "@/lib/files/naming";

export interface NewFileDialogProps {
  /** The kind of file being created, or `null` when the dialog is closed. */
  kind: NewFileKind | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
  pending?: boolean;
}

const TITLE_BY_KIND: Readonly<Record<NewFileKind, string>> = {
  text: "New text file",
  markdown: "New markdown file",
};

/**
 * Prompts for a name and creates a new, empty file of `kind` in the
 * current directory. Pre-fills a default name (`Untitled.txt` or
 * `Untitled.md`) with just its base selected, matching the rename
 * dialog's convention, so typing replaces the name but keeps the
 * extension.
 */
export function NewFileDialog({
  kind,
  onOpenChange,
  onCreate,
  pending = false,
}: NewFileDialogProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (kind !== null) {
      setName(defaultFileName(kind));
    }
  }, [kind]);

  function focusAndSelectBaseName(): boolean {
    const input = inputRef.current;
    if (input === null || kind === null) {
      return false;
    }
    const { base } = splitNameForSelection(defaultFileName(kind));
    input.focus();
    input.setSelectionRange(0, base.length);
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
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={focusAndSelectBaseName}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{kind !== null ? TITLE_BY_KIND[kind] : "New file"}</DialogTitle>
            <DialogDescription>Choose a name for the new file.</DialogDescription>
          </DialogHeader>
          <Field className="py-4">
            <Input
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="File name"
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
