import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function SetupFrame({
  children,
  description,
}: {
  children: ReactNode;
  description: string;
}) {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center p-4 sm:p-6">
      <Card className="w-full min-w-0 max-w-lg">
        <CardHeader className="items-center gap-1 text-center">
          <span className="text-lg font-semibold tracking-tight">fdrive</span>
          <CardTitle>Set up fdrive</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">{children}</CardContent>
      </Card>
    </main>
  );
}
