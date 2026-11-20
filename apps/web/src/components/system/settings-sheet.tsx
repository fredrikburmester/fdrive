"use client";

import { cn } from "cn";
import { XIcon } from "lucide-react";
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
  SheetClose,
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
    <Button type="button" variant="outline" size="lg" disabled={disabled} onClick={onClick}>
      Settings
    </Button>
  );
}

/**
 * How wide a System overlay sheet is: the whole screen on a phone, a column on the right
 * otherwise. Pass `SheetContent` this with `showCloseButton={false}` and start it with a
 * `SystemSheetHeader`, which brings the close button.
 */
export const SYSTEM_SHEET = "gap-0 data-[side=right]:w-full";

export interface SystemSheetHeaderProps {
  title: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  titleClassName?: string;
  /** More lines under the description, such as a link. */
  children?: ReactNode;
}

/**
 * The head of an overlay sheet that opens over a System area (settings, logs, failures): the
 * title with its one-line description, a round close button, and a hairline under it.
 */
export function SystemSheetHeader({
  title,
  description,
  titleClassName,
  children,
}: SystemSheetHeaderProps) {
  return (
    <SheetHeader className="flex-row items-start gap-3 border-border border-b py-4 pr-3 pl-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
        <SheetTitle
          className={cn("font-semibold text-lg leading-6 tracking-[-0.02em]", titleClassName)}
        >
          {title}
        </SheetTitle>
        {description !== undefined && description !== null ? (
          <SheetDescription>{description}</SheetDescription>
        ) : null}
        {children}
      </div>
      <SheetClose
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            className="-mt-1 size-11 shrink-0 rounded-full text-muted-foreground"
          />
        }
      >
        <XIcon aria-hidden="true" />
      </SheetClose>
    </SheetHeader>
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
 *
 * The fields a page passes in are drawn the way a detail sheet draws them:
 * 40px inputs on the page's ground and small muted descriptions.
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
      <SheetContent
        side="right"
        showCloseButton={false}
        className={cn(SYSTEM_SHEET, "data-[side=right]:sm:max-w-md")}
      >
        <SystemSheetHeader title={title} description={description} />
        <ScrollArea className="min-h-0 flex-1">
          <div
            data-slot="settings-sheet-fields"
            className={cn(
              "flex flex-col gap-5 p-5",
              "[&_[data-slot=field-description]]:text-xs",
              "[&_[data-slot=input]]:h-10 [&_[data-slot=input]]:bg-background [&_[data-slot=input]]:px-3",
              "[&_[data-slot=select-trigger]]:h-10! [&_[data-slot=select-trigger]]:bg-background [&_[data-slot=select-trigger]]:pl-3",
              "[&_[data-slot=textarea]]:bg-background [&_[data-slot=textarea]]:px-3",
            )}
          >
            {children}
            {validationMessages.length > 0 ? (
              <ul className="flex flex-col gap-1 text-destructive text-sm">
                {validationMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </ScrollArea>
        <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-border border-t px-5 py-4">
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
