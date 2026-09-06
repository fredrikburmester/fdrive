import type { ReactNode } from "react";

/**
 * Minimal stand-in for the shell chunk's
 * `src/components/shell/page-header.tsx`. `deps.ts` re-exports this until
 * the integration chunk repoints it at the real component. Exposes the two
 * slots this chunk's toolbar fills: a breadcrumb slot and an actions slot.
 */
export interface PageHeaderProps {
  readonly breadcrumb?: ReactNode;
  readonly actions?: ReactNode;
}

export function PageHeader({ breadcrumb, actions }: PageHeaderProps) {
  return (
    <header className="flex h-14 items-center justify-between gap-4 border-border border-b px-4">
      <div className="flex min-w-0 flex-1 items-center">{breadcrumb}</div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </header>
  );
}
