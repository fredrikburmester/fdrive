"use client";

/**
 * From Vercel's AI Elements registry (`@ai-elements/tool`), trimmed for
 * fdrive: the state is fdrive's own (`running`, `done`, `failed`) instead
 * of the AI SDK's, and output is shown in a plain preformatted block
 * instead of a shiki code block.
 */

import { cn } from "cn";
import { CheckCircleIcon, ChevronDownIcon, ClockIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export type ToolState = "running" | "done" | "failed";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose w-full rounded-md border", className)} {...props} />
);

export type ToolHeaderProps = {
  /** What the tool did, in the person's words, e.g. "Read invoice.pdf". */
  title: string;
  state: ToolState;
  className?: string;
};

const statusLabels: Record<ToolState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
};

const statusIcons: Record<ToolState, ReactNode> = {
  running: <ClockIcon className="size-3.5 animate-pulse motion-reduce:animate-none" />,
  done: <CheckCircleIcon className="size-3.5 text-emerald-600" />,
  failed: <XCircleIcon className="size-3.5 text-destructive" />,
};

export const ToolHeader = ({ className, title, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn("flex w-full items-center justify-between gap-3 px-3 py-2 text-left", className)}
    {...props}
  >
    <div className="flex min-w-0 items-center gap-2">
      <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-muted-foreground text-xs">{title}</span>
      <Badge className="gap-1 rounded-full text-[0.7rem]" variant="secondary">
        {statusIcons[state]}
        {statusLabels[state]}
      </Badge>
    </div>
    <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("space-y-3 border-t px-3 py-3 text-popover-foreground", className)}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  /** The arguments, already shortened for display. */
  input: string;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-1 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-[0.7rem] text-muted-foreground uppercase tracking-wide">
      Arguments
    </h4>
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs">
      {input}
    </pre>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  /** The result, already shortened for display. */
  output: string;
  failed?: boolean;
};

export const ToolOutput = ({ className, output, failed = false, ...props }: ToolOutputProps) => {
  if (output.length === 0) return null;
  return (
    <div className={cn("space-y-1", className)} {...props}>
      <h4 className="font-medium text-[0.7rem] text-muted-foreground uppercase tracking-wide">
        {failed ? "Error" : "Result"}
      </h4>
      <pre
        className={cn(
          "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 font-mono text-xs",
          failed ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {output}
      </pre>
    </div>
  );
};
