import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
}

/** A single labelled number, used for the counts on every System page. */
export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <Card className="min-w-0 gap-2 py-4">
      <CardHeader className="gap-0.5 px-4">
        <CardDescription className="text-xs md:text-sm">{label}</CardDescription>
        <CardTitle className="min-w-0 text-base font-semibold tabular-nums [overflow-wrap:anywhere] md:text-2xl">
          {value}
        </CardTitle>
      </CardHeader>
      {hint !== undefined ? (
        <CardContent className="px-4 text-xs text-muted-foreground">{hint}</CardContent>
      ) : null}
    </Card>
  );
}
