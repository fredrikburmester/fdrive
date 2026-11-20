import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * What a state looks like. `neutral` is a plain fact with no judgement (a count, "Watcher on"),
 * `off` is something turned off, and the other three are health.
 */
export type StatusTone = "neutral" | "success" | "warning" | "danger" | "off";

const BADGE_TONES: Record<StatusTone, string> = {
  neutral: "bg-muted text-subtle-foreground",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  danger: "bg-destructive-muted text-destructive",
  off: "bg-muted text-muted-foreground",
};

const BADGE_DOTS: Record<StatusTone, string> = {
  neutral: "bg-current",
  success: "bg-success-dot",
  warning: "bg-current",
  danger: "bg-current",
  off: "border border-current",
};

export interface StatusBadgeProps extends ComponentProps<"span"> {
  tone?: StatusTone;
  /** The dot ahead of the word. On by default for every tone but `neutral`. */
  dot?: boolean;
}

/**
 * A state as a word with a dot: Reachable, Healthy, On, Off. The word carries the meaning and
 * the color only repeats it, so a badge is never a dot or a color alone.
 */
export function StatusBadge({
  tone = "neutral",
  dot,
  className,
  children,
  ...props
}: StatusBadgeProps) {
  const showDot = dot ?? tone !== "neutral";
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-medium text-xs",
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    >
      {showDot ? (
        <span
          aria-hidden="true"
          data-slot="status-badge-dot"
          className={cn("size-1.5 shrink-0 rounded-full", BADGE_DOTS[tone])}
        />
      ) : null}
      {children}
    </span>
  );
}

const DOT_TONES: Record<Exclude<StatusTone, "neutral">, string> = {
  success: "bg-success-dot",
  warning: "bg-warning",
  danger: "bg-destructive",
  off: "border border-muted-foreground",
};

export interface StatusDotProps extends Omit<ComponentProps<"span">, "children"> {
  tone: Exclude<StatusTone, "neutral">;
  /** The state in a word, read in place of the dot: "On", "Off". */
  label: string;
}

/** A state where there is no room for its word, such as the end of a list row. */
export function StatusDot({ tone, label, className, ...props }: StatusDotProps) {
  return (
    <span
      role="img"
      aria-label={label}
      data-slot="status-dot"
      data-tone={tone}
      className={cn("size-2 shrink-0 rounded-full", DOT_TONES[tone], className)}
      {...props}
    />
  );
}
