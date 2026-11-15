"use client";

import { parentPath } from "@fdrive/core";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { viewHref } from "@/lib/files/path-url";
import { revealHref } from "@/lib/search/reveal";
import type { UploadItem } from "@/lib/upload/types";

export function UploadCompletionActions({ item }: { item: UploadItem }) {
  const router = useRouter();
  return (
    <div className="min-w-0">
      <p className="break-all text-xs text-muted-foreground">{parentPath(item.targetPath)}</p>
      <div className="flex flex-wrap gap-1">
        <Button
          className="min-h-11"
          variant="ghost"
          size="sm"
          onClick={() => router.push(viewHref(item.targetPath) as Route)}
        >
          Open
        </Button>
        <Button
          className="min-h-11"
          variant="ghost"
          size="sm"
          onClick={() => router.push(revealHref(item.targetPath) as Route)}
        >
          Show in folder
        </Button>
      </div>
    </div>
  );
}
