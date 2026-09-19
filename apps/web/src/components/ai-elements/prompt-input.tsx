"use client";

/**
 * From Vercel's AI Elements registry (`@ai-elements/prompt-input`), trimmed
 * for fdrive: the composer form, textarea, header, footer and buttons. OS
 * file attachments, speech input, model selects, action menus and hover
 * cards are gone; fdrive attaches files from the drive, not from disk.
 */

import { cn } from "cn";
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import type { ComponentProps, FormEvent, HTMLAttributes, KeyboardEventHandler } from "react";
import { Children, useCallback, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  /** Called with the trimmed text. Resolve to clear the textarea; reject to keep it for a retry. */
  onSubmit: (text: string, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const field = form.elements.namedItem("message");
      const text = field instanceof HTMLTextAreaElement ? field.value.trim() : "";
      if (text.length === 0) return;
      try {
        await onSubmit(text, event);
        if (field instanceof HTMLTextAreaElement) field.value = "";
      } catch {
        // Keep what was typed so the person can try again.
      }
    },
    [onSubmit],
  );

  return (
    <form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
      <InputGroup className="overflow-hidden">{children}</InputGroup>
    </form>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

/** Enter submits, Shift+Enter breaks the line, and composing text is left alone. */
export const PromptInputTextarea = ({
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.key !== "Enter") return;
      if (isComposing || event.nativeEvent.isComposing || event.shiftKey) return;
      event.preventDefault();
      const { form } = event.currentTarget;
      const submit = form?.querySelector('button[type="submit"]');
      if (submit instanceof HTMLButtonElement && submit.disabled) return;
      form?.requestSubmit();
    },
    [onKeyDown, isComposing],
  );

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputHeaderProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputHeader = ({ className, ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("order-first flex-wrap gap-1", className)}
    {...props}
  />
);

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 items-center gap-1", className)} {...props} />
);

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
  tooltip?: string;
};

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) => {
  const newSize = size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");
  const button = (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};

/** `submitted` while the request is on its way, `streaming` while the reply is being written. */
export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: PromptInputStatus;
  /** With a status of `streaming`, the button stops the reply instead of submitting. */
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status = "ready",
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === "submitted" || status === "streaming";
  let icon = <CornerDownLeftIcon className="size-4" />;
  if (status === "submitted") icon = <Spinner />;
  else if (status === "streaming") icon = <SquareIcon className="size-4" />;
  else if (status === "error") icon = <XIcon className="size-4" />;

  const handleClick = useCallback(
    (event: Parameters<NonNullable<PromptInputSubmitProps["onClick"]>>[0]) => {
      if (isGenerating && onStop) {
        event.preventDefault();
        onStop();
        return;
      }
      onClick?.(event);
    },
    [isGenerating, onStop, onClick],
  );

  return (
    <InputGroupButton
      aria-label={isGenerating ? "Stop" : "Send"}
      className={cn(className)}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? "button" : "submit"}
      variant={variant}
      {...props}
    >
      {children ?? icon}
    </InputGroupButton>
  );
};
