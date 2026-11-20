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
 * The shared parts of every page that is not a file listing. A page of rows (Shares, Trash, My
 * activity) is a `PageHeader`, then a `PageBody` holding a `PageBar` and a `DataTable` that reads
 * like the file list: full width, flat, 36px rows. A page that shows one thing in detail is a
 * `DetailSheet` (see `list-sheet.tsx` and docs/DESIGN.md), and the same `PageSection`,
 * `SettingRow` and `DataTable` inside one take the sheet's look through the `sheet:` variant: no
 * side padding, small muted headings and taller rows.
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
        "flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-border border-b px-3 py-1.5 text-muted-foreground text-xs sheet:min-h-0 sheet:border-b-0 sheet:p-0 sheet:text-sm",
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
 * One titled block: a title with an optional description and actions, then the content. On a
 * page, sections stack with a border between them and a muted header row, like groups in a
 * table. In a sheet the title is a small muted heading over the content, with no box.
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
      className={cn(
        "@container border-border border-b sheet:flex sheet:flex-col sheet:gap-3 sheet:border-b-0",
        className,
      )}
      {...props}
    >
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-border/60 border-b bg-muted/40 px-3 py-1.5 sheet:min-h-0 sheet:border-b-0 sheet:bg-transparent sheet:p-0">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-sm sheet:text-muted-foreground sheet:text-xs">{title}</h2>
          {description !== undefined && description !== null ? (
            <p className="text-muted-foreground text-xs sheet:mt-1 sheet:max-w-prose sheet:text-sm">
              {description}
            </p>
          ) : null}
        </div>
        {actions !== undefined && actions !== null ? (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {children !== undefined && children !== null ? (
        <div data-slot="page-section-content" className={cn(padded && "p-3 sheet:p-0")}>
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
  /**
   * `end` for a control with a size of its own (a switch, a segmented control, one button): it
   * sits at the far end of the row. Left out, the control shares the row with the label and
   * fills its half, as an input with its Save button does.
   */
  align?: "end";
  /** The control or value. */
  children?: ReactNode;
}

/**
 * A setting or a read-only detail: its label and one-line description on the left, the control
 * or value on the right, and a hairline above. The two stack where the row is narrow.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  align,
  className,
  children,
  ...props
}: SettingRowProps) {
  const labelClassName = "font-medium text-sm";
  return (
    <div
      data-slot="setting-row"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-border border-t py-4.5",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-[1_1_260px]">
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor} className={labelClassName}>
            {label}
          </label>
        ) : (
          <p className={labelClassName}>{label}</p>
        )}
        {description !== undefined && description !== null ? (
          <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      {children !== undefined && children !== null ? (
        <div
          data-slot="setting-control"
          className={cn(
            "min-w-0 text-sm",
            align === "end" ? "max-w-full flex-none" : "flex-[1_1_320px]",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The row that ends a form made of `SettingRow`s: its buttons at the far end, the primary one
 * last, with any error ahead of them.
 */
export function SettingActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-actions"
      className={cn(
        "flex flex-wrap items-center justify-end gap-x-2 gap-y-2 border-border border-t pt-4.5",
        className,
      )}
      {...props}
    />
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
 * hairline under each, and 12px of padding at both edges. In a sheet the rows are 52px, the
 * first cell is the row's name in medium weight, and the table runs to the sheet's own edges.
 * Compose it like the shadcn table.
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
        "h-9 border-border/60 transition-none hover:bg-muted/60 data-[state=selected]:bg-ring/10 sheet:h-13 sheet:border-border",
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
        "h-9 px-1.5 font-normal text-muted-foreground text-xs first:pl-3 last:pr-3 sheet:px-3 sheet:font-medium sheet:first:pl-0 sheet:last:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export function DataTableCell({ className, ...props }: ComponentProps<typeof TableCell>) {
  return (
    <TableCell
      className={cn(
        "px-1.5 py-1 first:pl-3 last:pr-3 sheet:px-3 sheet:first:pl-0 sheet:first:font-medium sheet:last:pr-0",
        className,
      )}
      {...props}
    />
  );
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
      className={cn("border-border/60 border-b bg-muted/40 sheet:bg-transparent", className)}
      {...props}
    >
      <th
        colSpan={colSpan}
        scope="colgroup"
        className="h-8 px-3 text-left align-middle font-medium text-muted-foreground text-xs sheet:px-0"
      >
        {children}
      </th>
    </tr>
  );
}
