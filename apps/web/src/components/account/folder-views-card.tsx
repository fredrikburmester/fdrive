"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useResetFolderViews } from "@/lib/files/folder-view-queries";
import { useDefaultView } from "@/lib/files/use-default-view";
import type { ViewMode } from "@/lib/files/view-mode";

const MODES: ViewMode[] = ["list", "grid", "tree"];
const LABELS = { list: "List", grid: "Grid", tree: "Tree" };

export function FolderViewsCard() {
  const [mode, setMode] = useDefaultView();
  const reset = useResetFolderViews();
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Folder views</CardTitle>
        <CardDescription>
          Changing View in a folder remembers its layout for that login across devices.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">Default view</p>
          <p className="text-sm text-muted-foreground">
            Used in this browser for folders without a saved view and for virtual listings.
          </p>
          <fieldset className="flex gap-2" aria-label="Default view">
            {MODES.map((value) => (
              <Button
                key={value}
                variant={mode === value ? "secondary" : "outline"}
                size="sm"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {LABELS[value]}
              </Button>
            ))}
          </fieldset>
        </div>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Remove saved views for every linked login. All folders will follow the default.
          </p>
          <Button variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}>
            {reset.isPending ? "Resetting…" : "Reset all folder views"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
