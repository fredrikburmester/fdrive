"use client";

import { Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SettingsFormActions } from "./settings-form";

/** The header control that opens a page's `SettingsSheet`. */
export function SystemSettingsButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button type="button" variant="outline" disabled={disabled} onClick={onClick}>
      <Settings2 />
      Settings
    </Button>
  );
}

export interface SettingsSheetProps {
  title: string;
  description?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dirty: boolean;
  invalid: boolean;
  pending: boolean;
  onSave: () => void;
  onReset: () => void;
  /** Why the draft cannot be saved, listed above the footer. */
  validationMessages?: readonly string[];
  children: ReactNode;
}

/**
 * A page's settings form in a right-hand sheet. The page keeps the draft and
 * its save/reset handlers; this only owns presentation and the guard against
 * losing an edit: closing while the draft is dirty asks first, so a stray
 * click on the backdrop or Escape cannot silently discard work.
 */
export function SettingsSheet({
  title,
  description,
  open,
  onOpenChange,
  dirty,
  invalid,
  pending,
  onSave,
  onReset,
  validationMessages = [],
  children,
}: SettingsSheetProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  function requestOpenChange(next: boolean) {
    if (!next && dirty && !pending) {
      setConfirmOpen(true);
      return;
    }
    onOpenChange(next);
  }

  function discard() {
    onReset();
    setConfirmOpen(false);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={requestOpenChange}>
      <SheetContent side="right" className="gap-0 sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{title}</SheetTitle>
          {description !== undefined ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-4">
            {children}
            {validationMessages.length > 0 ? (
              <ul className="text-sm text-destructive">
                {validationMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </ScrollArea>
        <SheetFooter className="flex-row justify-end gap-2 border-t">
          <SettingsFormActions
            dirty={dirty}
            invalid={invalid}
            pending={pending}
            onSave={onSave}
            onReset={onReset}
          />
        </SheetFooter>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Your changes have not been saved. Discarding returns every field to its saved value.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={discard}>
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
