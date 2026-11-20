import { cn } from "cn";
import { StatCard, type StatCardProps } from "./stat-card";

const COLUMN_CLASSES: Record<2 | 3 | 4 | 5, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3",
  4: "grid-cols-2 md:grid-cols-4",
  5: "grid-cols-2 md:grid-cols-3 lg:grid-cols-5",
};

export interface StatGridProps {
  stats: readonly StatCardProps[];
  /** Widest column count; narrower viewports always fall back to two. */
  columns?: 2 | 3 | 4 | 5;
  className?: string;
}

/**
 * The counts a System page reports, as a dense grid of cells divided by
 * hairlines. It belongs inside a `SystemSection`, edge to edge like a row.
 */
export function StatGrid({ stats, columns, className }: StatGridProps) {
  const resolved = columns ?? (Math.min(Math.max(stats.length, 2), 5) as 2 | 3 | 4 | 5);
  return (
    <dl
      data-slot="stat-grid"
      className={cn(
        "grid overflow-hidden border-border/60 border-b last:border-b-0",
        COLUMN_CLASSES[resolved],
        className,
      )}
    >
      {stats.map((stat) => (
        <StatCard key={stat.label} {...stat} />
      ))}
    </dl>
  );
}
