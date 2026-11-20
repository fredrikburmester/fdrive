import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

/** Read-only data inside a `DetailSheet`: bars for shares of a whole, facts for named values. */

export interface BarListItem {
  label: string;
  /** The count this bar stands for. */
  value: number;
  /** The text at the end of the row. Defaults to the count, grouped by thousands. */
  display?: ReactNode;
  /** `success` fills the bar green, `danger` writes the row in red; a plain bar is grey. */
  tone?: "neutral" | "success" | "danger";
}

export interface BarListProps extends Omit<ComponentProps<"ul">, "children"> {
  items: readonly BarListItem[];
  /** What a full bar stands for. Defaults to the sum of the items. */
  total?: number;
}

/** How a few counts share a whole, one bar per count, each with its name and number. */
export function BarList({ items, total, className, ...props }: BarListProps) {
  const whole = total ?? items.reduce((sum, item) => sum + item.value, 0);
  return (
    <ul
      data-slot="bar-list"
      // One grid for the whole list, so every bar starts and ends at the same place whatever the
      // labels and numbers beside it measure.
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 text-sm",
        className,
      )}
      {...props}
    >
      {items.map((item) => {
        const share = whole > 0 ? Math.min(item.value / whole, 1) : 0;
        return (
          <li
            key={item.label}
            data-tone={item.tone ?? "neutral"}
            className={cn(
              "col-span-3 grid grid-cols-subgrid items-center",
              item.tone === "danger" && item.value > 0 && "text-destructive",
            )}
          >
            <span className="min-w-0 truncate">{item.label}</span>
            <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
              <span
                data-slot="bar-fill"
                className={cn(
                  "block h-full rounded-full",
                  item.tone === "success"
                    ? "bg-success-dot"
                    : item.tone === "danger"
                      ? "bg-destructive"
                      : "bg-muted-foreground",
                )}
                style={{ width: `${(share * 100).toFixed(1)}%` }}
              />
            </span>
            <span className="text-right tabular-nums">
              {item.display ?? item.value.toLocaleString("en-US")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
}

export interface FactListProps extends Omit<ComponentProps<"dl">, "children"> {
  facts: readonly Fact[];
}

/** Named values a person reads but does not change: a version, a path, when something ran. */
export function FactList({ facts, className, ...props }: FactListProps) {
  return (
    <dl
      data-slot="fact-list"
      className={cn(
        "grid grid-cols-[minmax(6.875rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm",
        className,
      )}
      {...props}
    >
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A value a person copies (a revision, a path, an ID), in the mono face. */
export function Code({ className, ...props }: ComponentProps<"code">) {
  return <code className={cn("font-mono text-[13px]", className)} {...props} />;
}
