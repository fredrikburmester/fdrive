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
    <Card className="gap-2 py-4">
      <CardHeader className="gap-0.5 px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint !== undefined ? (
        <CardContent className="px-4 text-xs text-muted-foreground">{hint}</CardContent>
      ) : null}
    </Card>
  );
}
