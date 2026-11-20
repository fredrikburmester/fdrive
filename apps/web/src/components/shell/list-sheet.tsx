import { cn } from "cn";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { type ComponentProps, type ReactNode, useId } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * The Quiet frame (docs/DESIGN.md): one short list of areas beside one wide sheet that shows the
 * chosen area. System and Settings are this frame with different rows. A page is a `PageHeader`
 * holding a `ListSheetTrail`, then a `ListSheet` whose `list` is an `AreaList` and whose child is
 * the chosen area's `DetailSheet`.
 */

export interface ListSheetProps {
  /** The list column, normally an `AreaList`. */
  list: ReactNode;
  /**
   * True on the frame's own URL, where no area was asked for. A wide screen shows the first area
   * there. A phone shows the list as a screen of its own, and an area's URL shows only its sheet.
   * Which of the two shows is decided in CSS from the URL, so the server render already matches.
   */
  index: boolean;
  /** The chosen area's sheet. */
  children: ReactNode;
  className?: string;
}

export function ListSheet({ list, index, children, className }: ListSheetProps) {
  return (
    <div
      data-slot="list-sheet"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col md:flex-row", className)}
    >
      <div
        data-slot="list-sheet-list"
        // Stays in view under the page header while a long sheet scrolls.
        className={cn(
          "min-w-0 md:sticky md:top-12 md:max-h-[calc(100svh-3rem)] md:max-w-[300px] md:flex-[1_1_240px] md:self-start md:overflow-y-auto",
          !index && "max-md:hidden",
        )}
      >
        {list}
      </div>
      <div
        data-slot="list-sheet-content"
        className={cn(
          "flex min-w-0 flex-1 flex-col md:flex-[999_1_480px]",
          index && "max-md:hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export interface AreaListItem {
  readonly id: string;
  readonly label: string;
  readonly href: Route;
  /** One line under the label where the list is a screen of its own. */
  readonly description?: string;
}

export interface AreaListProps {
  /** The frame's name, shown above the rows on a wide screen: "System", "Settings". */
  title: string;
  /** Names the list for assistive technology. */
  label: string;
  items: readonly AreaListItem[];
  /** The area on screen, marked on a wide screen. */
  currentId: string;
  /** What sits at the end of a row: a `StatusDot`, a count. */
  renderEnd?: (item: AreaListItem) => ReactNode;
  /** A quiet line under the rows, such as who the areas apply to. */
  footer?: ReactNode;
  className?: string;
}

/**
 * The list column: a title, then one row per area with the chosen one on `muted`. On a phone it
 * is a screen of its own, where each row also says what is inside and ends in a chevron.
 */
export function AreaList({
  title,
  label,
  items,
  currentId,
  renderEnd,
  footer,
  className,
}: AreaListProps) {
  return (
    <nav
      aria-label={label}
      data-slot="area-list"
      className={cn("flex flex-col md:px-4 md:py-7", className)}
    >
      <p
        aria-hidden="true"
        className="mb-4 px-3 font-semibold text-[20px] leading-[26px] tracking-[-0.02em] max-md:hidden"
      >
        {title}
      </p>
      <ul className="flex flex-col md:gap-0.5">
        {items.map((item) => (
          <li key={item.id}>
            <AreaListRow item={item} active={item.id === currentId} end={renderEnd?.(item)} />
          </li>
        ))}
      </ul>
      {footer !== undefined && footer !== null ? (
        <div className="px-3 pt-4 text-muted-foreground text-xs">{footer}</div>
      ) : null}
    </nav>
  );
}

function AreaListRow({
  item,
  active,
  end,
}: {
  item: AreaListItem;
  active: boolean;
  end: ReactNode;
}) {
  const id = useId();
  const described = item.description !== undefined;
  return (
    <Link
      href={item.href}
      // Named by the label alone at every width; the line under it is its description.
      aria-labelledby={`${id}-label`}
      aria-describedby={described ? `${id}-description` : undefined}
      aria-current={active ? "page" : undefined}
      data-active={active ? "" : undefined}
      className={cn(
        "flex min-h-14 items-center gap-3 border-border border-b px-4 py-2 font-medium text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:bg-muted",
        "md:min-h-11 md:rounded-[10px] md:border-b-0 md:px-3 md:py-0 md:text-sm md:hover:bg-muted/60 md:data-active:bg-muted md:data-active:font-semibold",
      )}
    >
      <span className="min-w-0 flex-1">
        <span id={`${id}-label`} className="block truncate">
          {item.label}
        </span>
        {described ? (
          <span
            id={`${id}-description`}
            className="block truncate font-normal text-muted-foreground text-xs md:hidden"
          >
            {item.description}
          </span>
        ) : null}
      </span>
      {end}
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground/70 md:hidden"
      />
    </Link>
  );
}

export interface ListSheetTrailProps {
  /** The frame's name: "System", "Settings". */
  title: string;
  /** The frame's own URL, which is the list on a phone. */
  href: Route;
  /** True on the frame's own URL. */
  index: boolean;
}

/**
 * The page header's text for a `ListSheet`. It names the frame. On a phone inside an area it is
 * the way back to the list, and on the list itself it is the page's heading, since no sheet (and
 * so no sheet title) is on screen there.
 */
export function ListSheetTrail({ title, href, index }: ListSheetTrailProps) {
  return (
    <div data-slot="list-sheet-trail" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
      {index ? (
        <h1 className="truncate px-1.5 font-semibold text-[15px] md:hidden">{title}</h1>
      ) : (
        // A real link, not a button rendered as one: it goes to a page.
        <Link
          href={href}
          aria-label={`Back to ${title}`}
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "-ml-1 h-11 gap-0.5 px-1.5 font-semibold text-[15px] text-foreground md:hidden",
          )}
        >
          <ChevronLeft aria-hidden="true" className="size-5!" />
          {title}
        </Link>
      )}
      <span className="truncate px-1 text-muted-foreground max-md:hidden">{title}</span>
    </div>
  );
}

export interface DetailSheetProps extends Omit<ComponentProps<"section">, "title"> {
  /** What the sheet shows. The page's heading unless `titleAs` says otherwise. */
  title: ReactNode;
  /** `h2` for a sheet docked beside a page that has its own heading. */
  titleAs?: "h1" | "h2";
  /** One line under the title saying what this is. */
  lede?: ReactNode;
  /** `StatusBadge`s under the title. */
  badges?: ReactNode;
  /** Right of the title: the sheet's buttons, the one primary button last. */
  actions?: ReactNode;
  /** Closes a sheet that is docked beside a table. Adds the close button in its corner. */
  onClose?: () => void;
  /**
   * The last row, pushed to the bottom: a note on the left, and at the far end the destructive
   * text button, apart from every other action.
   */
  footer?: ReactNode;
  /**
   * `wide` fills the room beside an `AreaList`. `docked` is a fixed column beside a page that is
   * not a list of areas, such as the row chosen in a table.
   */
  width?: "wide" | "docked";
}

/**
 * The sheet: the chosen thing in detail, on `panel` with a hairline on its left and no shadow.
 * Blocks inside are 24px apart and divided by hairlines and small headings, never boxes.
 * Controls inside it are larger than the file browser's; the `sheet:` variant does that.
 */
export function DetailSheet({
  title,
  titleAs: Title = "h1",
  lede,
  badges,
  actions,
  onClose,
  footer,
  width = "wide",
  className,
  children,
  ...props
}: DetailSheetProps) {
  const id = useId();
  const hasActions = actions !== undefined && actions !== null;
  const closable = onClose !== undefined;
  return (
    <section
      data-slot="detail-sheet"
      data-width={width}
      aria-labelledby={`${id}-title`}
      className={cn(
        "@container relative flex min-w-0 flex-1 flex-col gap-6 border-border bg-panel px-4 py-5 md:border-l md:px-8 md:py-7",
        // Docked, by the room there is. Wide: its own column that stays under the page header
        // and scrolls by itself. Narrower: it floats over the right of the page, so the rows
        // keep their width. Phone: it covers the page, and its close button is the way back.
        width === "docked" && [
          "overflow-y-auto md:px-6",
          "max-md:fixed max-md:inset-0 max-md:z-40",
          "md:max-xl:fixed md:max-xl:top-12 md:max-xl:right-0 md:max-xl:bottom-0 md:max-xl:z-30 md:max-xl:w-[460px] md:max-xl:shadow-floating",
          "xl:sticky xl:top-12 xl:h-[calc(100svh-3rem)] xl:w-[460px] xl:max-w-[50%] xl:flex-none xl:self-start",
        ],
        className,
      )}
      {...props}
    >
      {closable ? (
        // In the sheet's corner, so it stays put whatever the title and the actions do.
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          className="absolute top-3 right-2 size-11 rounded-full text-muted-foreground md:top-5 md:right-4"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
      <header
        data-slot="detail-sheet-header"
        className={cn("flex flex-wrap items-start justify-between gap-4", closable && "pr-11")}
      >
        <div className="min-w-0 flex-[1_1_16rem]">
          <Title
            id={`${id}-title`}
            className="font-semibold text-[22px] leading-7 tracking-[-0.02em] [overflow-wrap:anywhere]"
          >
            {title}
          </Title>
          {lede !== undefined && lede !== null ? (
            <p className="mt-1.5 max-w-prose text-muted-foreground text-sm">{lede}</p>
          ) : null}
          {badges !== undefined && badges !== null ? (
            <div
              data-slot="detail-sheet-badges"
              className="mt-2.5 flex flex-wrap items-center gap-1.5"
            >
              {badges}
            </div>
          ) : null}
        </div>
        {hasActions ? (
          <div
            data-slot="detail-sheet-actions"
            className="flex max-w-full flex-wrap items-center gap-2 [&_[data-slot=button]]:h-11 [&_[data-slot=button]]:px-4.5"
          >
            {actions}
          </div>
        ) : null}
      </header>
      {children}
      {footer !== undefined && footer !== null ? (
        <footer
          data-slot="detail-sheet-footer"
          className="mt-auto flex flex-wrap items-center justify-between gap-3 border-border border-t pt-4.5 text-sm"
        >
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/**
 * Two short, related blocks side by side inside a sheet, such as bars beside facts. They wrap to
 * one column when the sheet is narrow.
 */
export function SheetColumns({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-columns"
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-8",
        className,
      )}
      {...props}
    />
  );
}

export interface SheetDockProps {
  /** The chosen row's `DetailSheet` with `width="docked"`, or nothing while no row is chosen. */
  sheet?: ReactNode;
  /** The page's own rows. */
  children: ReactNode;
  className?: string;
}

/**
 * A page of rows with the chosen row's sheet docked on its right: Shares, Trash, My activity.
 * The rows keep the room that is left, and the sheet is a column of its own that closes.
 */
export function SheetDock({ sheet, children, className }: SheetDockProps) {
  return (
    <div data-slot="sheet-dock" className={cn("flex min-h-0 min-w-0 flex-1", className)}>
      <div data-slot="sheet-dock-rows" className="flex min-w-0 flex-1 flex-col">
        {children}
      </div>
      {sheet}
    </div>
  );
}
