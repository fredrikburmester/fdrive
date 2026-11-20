"use client";

import { cn } from "cn";
import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import { PageSection } from "@/components/shell/page-layout";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Where a System component is drawn: flat on a page inside the shell, or as a
 * card in the setup walkthrough, which lives outside it in a narrow frame.
 */
export type SystemSurface = "page" | "card";

const SurfaceContext = createContext<SystemSurface>("page");

/** Draws the System components inside it as cards, for the setup walkthrough. */
export function SystemCardSurface({ children }: { children: ReactNode }) {
  return <SurfaceContext.Provider value="card">{children}</SurfaceContext.Provider>;
}

export function useSystemSurface(): SystemSurface {
  return useContext(SurfaceContext);
}

export interface SystemSectionProps {
  title: string;
  description?: ReactNode;
  /** Right-aligned controls for this section alone, such as a Test button. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /**
   * Pads and stacks content that is not rows. Leave it off for `SettingRow`s, a `StatGrid`, a
   * `SystemNote` or a `DataTable`, which bring their own edge padding and row borders.
   */
  padded?: boolean;
  contentClassName?: string;
}

/**
 * One titled block on a System page: a flat `PageSection` whose muted header
 * row carries the title, an optional description, and right-aligned actions,
 * with the section's rows under it. Every System page composes these, so
 * section spacing and the action alignment stay identical. Inside the setup
 * walkthrough the same block is a `Card`.
 */
export function SystemSection({
  title,
  description,
  actions,
  children,
  className,
  padded = false,
  contentClassName,
}: SystemSectionProps) {
  const surface = useSystemSurface();
  if (surface === "card") {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
          {actions !== undefined ? (
            <CardAction>
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            </CardAction>
          ) : null}
        </CardHeader>
        {children !== undefined ? (
          <CardContent className={cn("flex flex-col gap-3", contentClassName)}>
            {children}
          </CardContent>
        ) : null}
      </Card>
    );
  }
  return (
    <PageSection title={title} description={description} actions={actions} className={className}>
      {children === undefined ? undefined : padded ? (
        <div className={cn("flex flex-col gap-3 p-3 text-sm", contentClassName)}>{children}</div>
      ) : (
        children
      )}
    </PageSection>
  );
}

/**
 * Prose inside a section: an explanation, a caveat, a short list. Padded and
 * bordered like a row, in small muted text, and kept to a readable width.
 */
export function SystemNote({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="system-note"
      className={cn(
        "flex flex-col gap-1.5 border-border/60 border-b px-3 py-2.5 text-muted-foreground text-xs last:border-b-0 [&>ol]:max-w-4xl [&>p]:max-w-4xl [&>ul]:max-w-4xl",
        className,
      )}
      {...props}
    />
  );
}

/** A line of page-level text outside any section, such as "Loading…". */
export function SystemLine({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("px-3 py-2.5 text-muted-foreground text-sm", className)} {...props} />;
}

/**
 * A problem, said in the destructive colour. With `row` it stands as a row of
 * its own inside a section, padded and bordered like the rows around it.
 */
export function SystemAlert({
  row = false,
  className,
  ...props
}: ComponentProps<"p"> & { row?: boolean }) {
  return (
    <p
      role="alert"
      className={cn(
        "text-destructive text-sm [overflow-wrap:anywhere]",
        row && "border-border/60 border-b px-3 py-2.5 last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}
