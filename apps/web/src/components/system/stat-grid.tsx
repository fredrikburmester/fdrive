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

/** The row of `StatCard` counts every System page opens with. */
export function StatGrid({ stats, columns, className }: StatGridProps) {
  const resolved = columns ?? (Math.min(Math.max(stats.length, 2), 5) as 2 | 3 | 4 | 5);
  return (
    <div className={cn("grid gap-3", COLUMN_CLASSES[resolved], className)}>
      {stats.map((stat) => (
        <StatCard key={stat.label} {...stat} />
      ))}
    </div>
  );
}
