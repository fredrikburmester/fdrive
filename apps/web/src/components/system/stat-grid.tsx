import { cn } from "cn";
import { StatCard, type StatCardProps } from "./stat-card";

export interface StatGridProps {
  stats: readonly StatCardProps[];
  className?: string;
}

/**
 * The headline counts of a System sheet, as one row of large numbers between two hairlines.
 * It wraps where the sheet is narrow. Keep it to numbers: a name, a path or a state belongs in
 * a `FactList` or a `StatusBadge`.
 */
export function StatGrid({ stats, className }: StatGridProps) {
  return (
    <dl
      data-slot="stat-grid"
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-x-4 gap-y-5 border-border border-y py-5",
        className,
      )}
    >
      {stats.map((stat) => (
        <StatCard key={stat.label} {...stat} />
      ))}
    </dl>
  );
}
