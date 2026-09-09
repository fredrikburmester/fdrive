import { cn } from "cn";
import type { ReactNode } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface SystemSectionProps {
  title: string;
  description?: ReactNode;
  /** Right-aligned controls for this section alone, such as a Test button. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * One titled block on a System page: a `Card` whose header row carries the
 * title, an optional description, and right-aligned actions. Every System
 * page composes these instead of hand-writing the same Card/CardHeader
 * pairing, so section spacing and the action alignment stay identical.
 */
export function SystemSection({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: SystemSectionProps) {
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
