import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
}

/**
 * A single labelled number: one cell of a `StatGrid`, with a hairline to its
 * right and under it that the grid clips at its own edges.
 */
export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div
      data-slot="stat"
      className="-mr-px -mb-px min-w-0 border-border/60 border-r border-b px-3 py-2"
    >
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 font-medium text-sm tabular-nums [overflow-wrap:anywhere]">{value}</dd>
      {hint !== undefined ? <dd className="text-muted-foreground text-xs">{hint}</dd> : null}
    </div>
  );
}
