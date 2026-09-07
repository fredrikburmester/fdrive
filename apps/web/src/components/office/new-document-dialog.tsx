"use client";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OFFICE_DOCUMENT_LABELS,
  type OfficeDocumentFormat,
  type OfficeDocumentKind,
  officeDocumentName,
  validateOfficeDocumentName,
} from "@/lib/office/new-document";

export interface NewOfficeDocumentDialogProps {
  kind: OfficeDocumentKind;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
}

export function NewOfficeDocumentDialog({
  kind,
  pending,
  error,
  onClose,
  onCreate,
}: NewOfficeDocumentDialogProps) {
  const [format, setFormat] = useState<OfficeDocumentFormat>("ooxml");
  const [name, setName] = useState(() => officeDocumentName("Untitled", kind, "ooxml"));
  const invalid = validateOfficeDocumentName(name, kind, format);
  function changeFormat(value: string | null) {
    if (value !== "ooxml" && value !== "odf") return;
    setFormat(value);
    setName(officeDocumentName(name, kind, value));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!pending && invalid === null) onCreate(name);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New {OFFICE_DOCUMENT_LABELS[kind].toLowerCase()}</DialogTitle>
            <DialogDescription>
              Create a document in this folder and open it for editing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="office-format">Format</Label>
            <Select value={format} onValueChange={changeFormat} disabled={pending}>
              <SelectTrigger id="office-format" className="w-full">
                <SelectValue>{format === "ooxml" ? "Office Open XML" : "OpenDocument"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ooxml">Office Open XML</SelectItem>
                <SelectItem value="odf">OpenDocument</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Choose the file format used by your office applications.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="office-name">File name</Label>
            <Input
              id="office-name"
              value={name}
              disabled={pending}
              aria-invalid={invalid !== null}
              aria-describedby="office-name-help"
              onChange={(event) => setName(event.target.value)}
            />
            <p id="office-name-help" className="text-muted-foreground text-xs">
              The extension must match the chosen format.
            </p>
          </div>
          {(invalid ?? error) !== null && (
            <p role="alert" className="text-destructive text-sm">
              {invalid ?? error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || invalid !== null}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
