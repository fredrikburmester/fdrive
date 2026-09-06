import type { DocumentStats } from "@/lib/editor/document-stats";

export interface EditorStatusBarProps {
  readonly stats: DocumentStats;
}

/** The bottom status line: cursor position, document length, encoding. */
export function EditorStatusBar({ stats }: EditorStatusBarProps) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-background/80 px-3 text-xs text-muted-foreground tabular-nums backdrop-blur-sm supports-backdrop-filter:bg-background/60">
      <span>
        Line {stats.line}, Column {stats.column}
      </span>
      <span>
        {stats.length} character{stats.length === 1 ? "" : "s"}
      </span>
      <span>UTF-8</span>
    </div>
  );
}
