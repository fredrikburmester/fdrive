"use client";

import type { StorageFile, StorageKind, StorageUsageResponse } from "@fdrive/contracts";
import { baseName, extensionOf, mimeFromExtension, parentPath } from "@fdrive/core";
import {
  FileIcon as FileGenericIcon,
  FileTextIcon,
  FilmIcon,
  FolderOpenIcon,
  ImageIcon,
  type LucideIcon,
  MusicIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { FileIcon } from "@/components/files/file-icon";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describeApiError } from "@/lib/api/errors";
import { revealHref } from "@/lib/search/reveal";
import { useStorageUsage } from "@/lib/storage/queries";
import { useFormatters } from "@/lib/use-format-preferences";

const KINDS: Readonly<Record<StorageKind, { label: string; Icon: LucideIcon }>> = {
  images: { label: "Images", Icon: ImageIcon },
  videos: { label: "Videos", Icon: FilmIcon },
  documents: { label: "Documents", Icon: FileTextIcon },
  audio: { label: "Audio", Icon: MusicIcon },
  other: { label: "Other", Icon: FileGenericIcon },
};

/** Used space against the limit, when there is one, and how it splits by kind. */
function UsageCard({ usage }: { usage: StorageUsageResponse }) {
  const { formatBytes } = useFormatters();
  const { used, limit } = usage;
  const summary =
    limit === null
      ? `${formatBytes(used)} used`
      : `${formatBytes(used)} of ${formatBytes(limit)} used`;
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          {usage.indexed
            ? summary
            : "Storage use comes from the search index, which does not cover your files yet."}
        </CardDescription>
      </CardHeader>
      {usage.indexed ? (
        <CardContent className="flex flex-col gap-4">
          {limit === null ? null : (
            <Progress value={Math.min(100, (used / limit) * 100)} aria-label="Storage used" />
          )}
          <ul className="flex flex-col gap-2.5">
            {usage.kinds.map(({ kind, bytes }) => {
              const { label, Icon } = KINDS[kind];
              return (
                <li key={kind} className="flex items-center gap-3 text-sm">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="w-24 shrink-0">{label}</span>
                  <Progress
                    className="flex-1"
                    value={used === 0 ? 0 : (bytes / used) * 100}
                    aria-label={`${label} share`}
                  />
                  <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                    {formatBytes(bytes)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            Counted from the search index, Trash included, so recent changes can take a moment to
            show and the limit is approximate.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

/** One of the largest files: where it is, its size, and a way to it. */
function LargeFile({ file }: { file: StorageFile }) {
  const { formatBytes } = useFormatters();
  const name = baseName(file.path);
  const ext = extensionOf(name);
  return (
    <li className="flex min-w-0 items-center gap-3 py-2 text-sm">
      <FileIcon kind="file" ext={ext} mime={mimeFromExtension(ext)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{parentPath(file.path)}</span>
      </div>
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              nativeButton={false}
              variant="ghost"
              size="icon-sm"
              aria-label={`Reveal ${name} in folder`}
              render={<Link href={revealHref(file.path) as Route} />}
            />
          }
        >
          <FolderOpenIcon />
        </TooltipTrigger>
        <TooltipContent>Reveal in folder</TooltipContent>
      </Tooltip>
    </li>
  );
}

/**
 * `/storage`: how much the signed-in login's own folder holds, by kind and
 * against its storage limit, and its largest files, all from the index.
 */
export function StoragePage() {
  const { data, isLoading, isError, error } = useStorageUsage();
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">Storage</span>} />
      <div className="flex flex-1 flex-col items-center gap-4 p-6">
        {isLoading ? <Skeleton className="h-64 w-full max-w-2xl" /> : null}
        {isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeApiError(error)}
          </p>
        ) : null}
        {data === undefined ? null : <UsageCard usage={data} />}
        {data?.indexed === true && data.largest.length > 0 ? (
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle>Largest files</CardTitle>
              <CardDescription>Your biggest files outside Trash, largest first.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y">
                {data.largest.map((file) => (
                  <LargeFile key={file.path} file={file} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
