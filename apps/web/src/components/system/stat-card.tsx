import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
}

/** A single headline number with its label under it: one cell of a `StatGrid`. */
export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div data-slot="stat" className="flex min-w-0 flex-col gap-0.5">
      <dt className="order-2 text-muted-foreground text-xs">{label}</dt>
      <dd className="order-1 min-w-0 font-semibold text-[26px] leading-[30px] tracking-[-0.02em] tabular-nums [overflow-wrap:anywhere]">
        {value}
      </dd>
      {hint !== undefined ? (
        <dd className="order-3 text-muted-foreground text-xs">{hint}</dd>
      ) : null}
    </div>
  );
}
