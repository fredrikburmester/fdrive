"use client";

import type { ArchiveFormat } from "@fdrive/core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export interface CompressDialogState {
  readonly paths: readonly string[];
  readonly format: ArchiveFormat;
  readonly name: string;
  readonly destination: string;
}

export interface CompressDialogProps {
  /** `null` closes the dialog. */
  state: CompressDialogState | null;
  onOpenChange: (open: boolean) => void;
  onFormatChange: (format: ArchiveFormat) => void;
  onNameChange: (name: string) => void;
  onChangeDestination: () => void;
  onSubmit: () => void;
  pending?: boolean;
}

const FORMAT_OPTIONS: ReadonlyArray<{
  value: ArchiveFormat;
  label: string;
  description: string;
}> = [
  { value: "zip", label: "Zip", description: "Widely compatible, opens on any platform." },
  { value: "tar.gz", label: "Tar.gz", description: "Compact, the standard on Linux and macOS." },
  { value: "tar.zst", label: "Tar.zst", description: "Fastest to build, best for large files." },
];

/**
 * Builds an archive from a selection: format, name, and destination
 * (changed through the shared `DestinationPicker`, opened by the caller in
 * response to `onChangeDestination`). Submits by calling `onSubmit` with
 * the values already reflected in `state`, which the caller owns.
 */
export function CompressDialog({
  state,
  onOpenChange,
  onFormatChange,
  onNameChange,
  onChangeDestination,
  onSubmit,
  pending = false,
}: CompressDialogProps) {
  const trimmedName = state?.name.trim() ?? "";

  return (
    <Dialog open={state !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Compress</DialogTitle>
          <DialogDescription>
            {state !== null && state.paths.length === 1
              ? "Build an archive from this item."
              : "Build an archive from the selection."}
          </DialogDescription>
        </DialogHeader>

        {state !== null && (
          <div className="flex flex-col gap-4 py-2">
            <Field>
              <Input
                value={state.name}
                onChange={(event) => onNameChange(event.target.value)}
                aria-label="Archive name"
              />
            </Field>

            <RadioGroup
              value={state.format}
              onValueChange={(value) => onFormatChange(value as ArchiveFormat)}
            >
              {FORMAT_OPTIONS.map((option) => (
                <FieldLabel key={option.value} htmlFor={`archive-format-${option.value}`}>
                  <Field orientation="horizontal" className="rounded-lg border border-border p-2.5">
                    <RadioGroupItem value={option.value} id={`archive-format-${option.value}`} />
                    <div className="flex flex-col gap-0.5">
                      <FieldTitle>{option.label}</FieldTitle>
                      <FieldDescription>{option.description}</FieldDescription>
                    </div>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>

            <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <span className="truncate text-muted-foreground" title={state.destination}>
                {state.destination}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={onChangeDestination}>
                Change…
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={trimmedName.length === 0 || pending} onClick={onSubmit}>
            Compress
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
