import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The shared look of every page that is not a file listing: the full width of the window, flat
 * bordered rows in place of cards, and tables whose header and rows match the file list. A page
 * is a `PageHeader`, then a `PageBody` holding any of a `PageBar`, `PageSection`s and a
 * `DataTable`.
 */

/**
 * The page under its `PageHeader`: full width, edge to edge, no outer padding. A `div`, since the
 * shell's inset is already the page's `main`. It is a size container, so rows inside lay
 * themselves out by the room the page really has beside the sidebar, not by the window.
 */
export function PageBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page-body"
      className={cn("@container flex min-w-0 flex-1 flex-col", className)}
      {...props}
    />
  );
}

export interface PageBarProps extends Omit<ComponentProps<"div">, "children"> {
  /** What the page shows, on the left: a count, a one-line description, filters. */
  children?: ReactNode;
  /** Right-aligned controls for the whole page. */
  actions?: ReactNode;
}

/** The strip under the header: a summary on the left and the page's actions on the right. */
export function PageBar({ children, actions, className, ...props }: PageBarProps) {
  return (
    <div
      data-slot="page-bar"
      className={cn(
        "flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-border border-b px-3 py-1.5 text-muted-foreground text-xs",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{children}</div>
      {actions !== undefined && actions !== null ? (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

export interface PageSectionProps extends Omit<ComponentProps<"section">, "title"> {
  title: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** Right-aligned controls for this section alone. */
  actions?: ReactNode;
  /**
   * Pads the content. Leave it off (the default) when the content is `SettingRow`s or a
   * `DataTable`, which bring their own edge padding and row borders.
   */
  padded?: boolean;
}

/**
 * One titled block of a page: a header row with the title, an optional description and actions,
 * then the content. Sections stack with a border between them, like groups in a table.
 */
export function PageSection({
  title,
  description,
  actions,
  padded = false,
  className,
  children,
  ...props
}: PageSectionProps) {
  return (
    <section
      data-slot="page-section"
      className={cn("@container border-border border-b", className)}
      {...props}
    >
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-border/60 border-b bg-muted/40 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-sm">{title}</h2>
          {description !== undefined && description !== null ? (
            <p className="text-muted-foreground text-xs">{description}</p>
          ) : null}
        </div>
        {actions !== undefined && actions !== null ? (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {children !== undefined && children !== null ? (
        <div data-slot="page-section-content" className={cn(padded && "p-3")}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export interface SettingRowProps extends Omit<ComponentProps<"div">, "children"> {
  label: ReactNode;
  /** One line saying what the setting does, or what the current choice means. */
  description?: ReactNode;
  /** The id of the control this row labels; without it, give the control its own `aria-label`. */
  htmlFor?: string;
  /** The control or value. */
  children?: ReactNode;
}

/**
 * A setting or a read-only detail as one table-like row: the label and its one-line description
 * in a fixed left column, the control or value beside it. Stacks where the section around it is
 * narrow: a phone, or a small window beside the sidebar.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  className,
  children,
  ...props
}: SettingRowProps) {
  const labelClassName = "font-medium text-sm";
  return (
    <div
      data-slot="setting-row"
      className={cn(
        "grid gap-x-6 gap-y-2 border-border/60 border-b px-3 py-2.5 last:border-b-0 @2xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] @2xl:items-center",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor} className={labelClassName}>
            {label}
          </label>
        ) : (
          <p className={labelClassName}>{label}</p>
        )}
        {description !== undefined && description !== null ? (
          <p className="text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

/**
 * The row that ends a form made of `SettingRow`s: its buttons and any error line up with the
 * controls above them, and sit under the labels where the rows stack.
 */
export function SettingActions({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-actions"
      className={cn(
        "grid gap-x-6 px-3 py-2.5 @2xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 @2xl:col-start-2">
        {children}
      </div>
    </div>
  );
}

export interface PageEmptyProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

/** Shown in place of a page's rows when there is nothing to list; matches an empty folder. */
export function PageEmpty({ icon: Icon, title, description, action }: PageEmptyProps) {
  return (
    <div
      data-slot="page-empty"
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center"
    >
      {Icon !== undefined ? (
        <Icon className="size-10 text-muted-foreground/60" aria-hidden="true" />
      ) : null}
      <div className="space-y-1">
        <p className="font-medium text-sm">{title}</p>
        {description !== undefined && description !== null ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * A table that reads like the file list: full width, a muted header row, 36px rows with a
 * hairline under each, and 12px of padding at both edges. Compose it like the shadcn table.
 */
export function DataTable({ className, ...props }: ComponentProps<typeof Table>) {
  return <Table className={cn("text-sm", className)} {...props} />;
}

export function DataTableHeader({ className, ...props }: ComponentProps<typeof TableHeader>) {
  return (
    <TableHeader
      className={cn("[&_tr]:border-border [&_tr]:hover:bg-transparent", className)}
      {...props}
    />
  );
}

export function DataTableBody(props: ComponentProps<typeof TableBody>) {
  return <TableBody {...props} />;
}

export function DataTableRow({ className, ...props }: ComponentProps<typeof TableRow>) {
  return (
    <TableRow
      className={cn(
        "h-9 border-border/60 transition-none hover:bg-muted/60 data-[state=selected]:bg-primary/10",
        className,
      )}
      {...props}
    />
  );
}

export function DataTableHead({ className, ...props }: ComponentProps<typeof TableHead>) {
  return (
    <TableHead
      className={cn(
        "h-9 px-1.5 font-normal text-muted-foreground text-xs first:pl-3 last:pr-3",
        className,
      )}
      {...props}
    />
  );
}

export function DataTableCell({ className, ...props }: ComponentProps<typeof TableCell>) {
  return <TableCell className={cn("px-1.5 py-1 first:pl-3 last:pr-3", className)} {...props} />;
}

/** A full-width row inside a `DataTable` that titles the rows under it, such as a day. */
export function DataTableGroupRow({
  colSpan,
  className,
  children,
  ...props
}: ComponentProps<"tr"> & { colSpan: number }) {
  return (
    <tr
      data-slot="table-group-row"
      className={cn("border-border/60 border-b bg-muted/40", className)}
      {...props}
    >
      <th
        colSpan={colSpan}
        scope="colgroup"
        className="h-8 px-3 text-left align-middle font-medium text-muted-foreground text-xs"
      >
        {children}
      </th>
    </tr>
  );
}
