"use client";

import type { PublicShare, ShareEntriesResponse } from "@fdrive/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { File, Folder, Link2, RefreshCw } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type PublicShareClient, publicShareClient } from "@/lib/shares/client";
import { appendShareName, publicShareHref, shareBreadcrumbs } from "@/lib/shares/paths";
import { canPeekArchive } from "@/lib/shares/peek";
import {
  galleryEntries,
  resolveEntriesPresentation,
  resolveSingleFilePresentation,
} from "@/lib/shares/presentation";
import { publicPreviewKind } from "@/lib/shares/preview";
import {
  publicShareKey,
  publicShareMetadataKey,
  usePublicShare,
  useShareEntries,
} from "@/lib/shares/public-queries";
import { publicShareUsage, shareUnavailable } from "@/lib/shares/status";
import { createShareUploadQueue } from "@/lib/shares/uploads";
import { NativeShareDownload } from "./native-download";
import { PublicArchivePeek } from "./public-archive-peek";
import { PublicGallery } from "./public-gallery";
import { PublicPreview } from "./public-preview";
import { PublicUpload } from "./public-upload";

/** Reused whenever the resolved presentation is a single prominent download action. */
function ZipDownloadCard({ id, client }: { id: string; client: PublicShareClient }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The shared files are available together as a ZIP archive.
      </p>
      <NativeShareDownload href={client.shareArchiveUrl(id)} label="Download ZIP" />
    </div>
  );
}

function DirectoryListing({
  id,
  path,
  presentation,
  downloadLimited,
  listing,
  client,
  onPreview,
  onPeek,
}: {
  id: string;
  path: string;
  presentation: PublicShare["presentation"];
  /** Whether the share has a download limit; previews are never rendered for a limited link. */
  downloadLimited: boolean;
  listing: ReturnType<typeof useShareEntries>;
  client: PublicShareClient;
  onPreview: (name: string, path: string, size: number) => void;
  onPeek: (name: string, path: string, size: number) => void;
}) {
  if (listing.isError) return <FieldError>{listing.error.message}</FieldError>;
  if (listing.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading shared files…
      </p>
    );
  const resolved = resolveEntriesPresentation(presentation, listing.data.items, {
    downloadLimited,
  });
  if (resolved === "download") return <ZipDownloadCard id={id} client={client} />;
  if (resolved === "gallery")
    return (
      <PublicGallery
        images={galleryEntries(listing.data.items).map((entry) => ({
          name: entry.name,
          path: appendShareName(path, entry.name),
        }))}
        thumbUrl={(entryPath, size) => client.shareThumbUrl(id, entryPath, size)}
        downloadUrl={(entryPath) => client.shareDownloadUrl(id, entryPath)}
      />
    );
  return (
    <SharedEntries
      id={id}
      path={path}
      entries={listing.data.items}
      downloadLimited={downloadLimited}
      onPreview={onPreview}
      onPeek={onPeek}
    />
  );
}

interface SelectedPreview {
  name: string;
  path: string;
  kind: Exclude<ReturnType<typeof publicPreviewKind>, "none">;
  generation: number;
  folder: string;
}

interface SelectedPeek {
  name: string;
  path: string;
  /** Undefined for a single-file archive share, whose metadata carries no size. */
  size: number | undefined;
  generation: number;
  folder: string;
}

function SharedContents({
  id,
  path,
  share,
  generation,
  pending,
  uploads,
}: {
  id: string;
  path: string;
  share: PublicShare;
  generation: number;
  pending: boolean;
  uploads: ReturnType<typeof createShareUploadQueue>;
}) {
  const client = publicShareClient();
  const unavailable = shareUnavailable(share);
  const enabled = !pending && !unavailable && (!share.hasPassword || share.credentialPresent);
  const listing = useShareEntries(
    id,
    path,
    generation,
    enabled && share.scope === "read" && share.layout === "directory",
  );
  const [preview, setPreview] = useState<SelectedPreview | null>(null);
  const [peek, setPeek] = useState<SelectedPeek | null>(null);
  function previewFile(name: string, filePath: string, size?: number) {
    const kind = publicPreviewKind(name, size);
    if (kind !== "none") setPreview({ name, path: filePath, kind, generation, folder: path });
  }
  function peekArchive(name: string, filePath: string, size?: number) {
    setPeek({ name, path: filePath, size, generation, folder: path });
  }
  if (unavailable) return <FieldError>{unavailable}</FieldError>;
  if (share.scope === "write") return <PublicUpload queue={uploads} enabled={enabled} />;
  if (pending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Updating access…
      </p>
    );
  if (!enabled)
    return <p className="text-sm text-muted-foreground">Enter the share password to continue.</p>;
  const singleFilePresentation = resolveSingleFilePresentation(share.presentation, share.fileName, {
    downloadLimited: share.maxDownloads > 0,
  });
  return (
    <div className="space-y-5">
      {share.layout === "directory" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Breadcrumb>
              <BreadcrumbList>
                {shareBreadcrumbs(path).map((crumb, index, crumbs) => (
                  <span key={crumb.path} className="contents">
                    {index > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem>
                      {index === crumbs.length - 1 ? (
                        <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          render={<Link href={publicShareHref(id, crumb.path) as Route} />}
                        >
                          {crumb.name}
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </span>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <NativeShareDownload href={client.shareArchiveUrl(id)} label="Download ZIP" icon />
          </div>
          <DirectoryListing
            id={id}
            path={path}
            presentation={share.presentation}
            downloadLimited={share.maxDownloads > 0}
            listing={listing}
            client={client}
            onPreview={previewFile}
            onPeek={peekArchive}
          />
        </>
      ) : share.layout === "archive" ? (
        <ZipDownloadCard id={id} client={client} />
      ) : singleFilePresentation === "gallery" ? (
        <PublicGallery
          images={[{ name: share.fileName ?? "Shared file", path: "/" }]}
          thumbUrl={(entryPath, size) => client.shareThumbUrl(id, entryPath, size)}
          downloadUrl={(entryPath) => client.shareDownloadUrl(id, entryPath)}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <File className="size-6 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{share.fileName ?? "Shared file"}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {share.fileName && publicPreviewKind(share.fileName) !== "none" && (
              <Button variant="outline" onClick={() => previewFile(share.fileName ?? "", "/")}>
                Preview
              </Button>
            )}
            {share.fileName &&
              canPeekArchive(share.fileName, { downloadLimited: share.maxDownloads > 0 }) && (
                <Button variant="outline" onClick={() => peekArchive(share.fileName ?? "", "/")}>
                  Peek
                </Button>
              )}
            <NativeShareDownload href={client.shareDownloadUrl(id)} />
          </div>
        </div>
      )}
      {preview?.generation === generation && preview.folder === path && (
        <PublicPreview
          key={`${generation}:${preview.path}`}
          url={client.shareDownloadUrl(id, preview.path)}
          name={preview.name}
          kind={preview.kind}
          onClose={() => setPreview(null)}
        />
      )}
      {peek?.generation === generation && peek.folder === path && (
        <PublicArchivePeek
          key={`${generation}:${peek.path}`}
          id={id}
          path={peek.path}
          name={peek.name}
          size={peek.size}
          generation={generation}
          onClose={() => setPeek(null)}
        />
      )}
    </div>
  );
}

function SharedEntries({
  id,
  path,
  entries,
  downloadLimited,
  onPreview,
  onPeek,
}: {
  id: string;
  path: string;
  entries: ShareEntriesResponse["items"];
  downloadLimited: boolean;
  onPreview: (name: string, path: string, size: number) => void;
  onPeek: (name: string, path: string, size: number) => void;
}) {
  const client = publicShareClient();
  if (entries.length === 0)
    return (
      <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        This shared folder is empty.
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Size</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const entryPath = appendShareName(path, entry.name);
          const kind = entry.kind === "file" ? publicPreviewKind(entry.name, entry.size) : "none";
          return (
            <TableRow key={entryPath}>
              <TableCell>
                <div className="flex items-center gap-2">
                  {entry.kind === "dir" ? (
                    <Folder className="size-4 text-muted-foreground" />
                  ) : (
                    <File className="size-4 text-muted-foreground" />
                  )}
                  {entry.kind === "dir" ? (
                    <Button
                      variant="link"
                      className="h-auto px-0 text-foreground"
                      nativeButton={false}
                      role="link"
                      render={<Link href={publicShareHref(id, entryPath) as Route} />}
                    >
                      {entry.name}
                    </Button>
                  ) : (
                    <span>{entry.name}</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {entry.kind === "dir" ? "—" : `${entry.size.toLocaleString()} bytes`}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  {kind !== "none" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onPreview(entry.name, entryPath, entry.size)}
                    >
                      Preview
                    </Button>
                  )}
                  {entry.kind === "file" && canPeekArchive(entry.name, { downloadLimited }) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onPeek(entry.name, entryPath, entry.size)}
                    >
                      Peek
                    </Button>
                  )}
                  {entry.kind === "file" && (
                    <NativeShareDownload href={client.shareDownloadUrl(id, entryPath)} />
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function PublicSharePage({ id, path }: { id: string; path: string }) {
  const [uploads] = useState(() => createShareUploadQueue(id));
  const [generation, setGeneration] = useState(0);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const metadata = usePublicShare(id, generation);
  const credentialRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    uploads.activate();
    return () => uploads.dispose();
  }, [uploads]);
  useEffect(
    () => () => {
      credentialRequest.current?.abort();
      void queryClient.cancelQueries({ queryKey: publicShareKey(id) });
      queryClient.removeQueries({ queryKey: publicShareKey(id) });
    },
    [id, queryClient],
  );
  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    uploads.credentialsChanged();
    const value = password;
    setPassword("");
    setError(null);
    setPending(true);
    const controller = new AbortController();
    credentialRequest.current = controller;
    let latest = metadata.data;
    try {
      await queryClient.cancelQueries({ queryKey: publicShareKey(id) });
      queryClient.removeQueries({
        queryKey: publicShareKey(id),
        predicate: (query) => query.queryKey[3] === "entries",
      });
      const client = publicShareClient(controller.signal);
      await client.setSharePassword(id, value);
      latest = await client.publicShare(id);
      // A viewable share reports whether the stored password verified; an
      // upload share cannot be checked until something is uploaded.
      if (latest.hasPassword && latest.scope === "read" && !latest.credentialPresent)
        setError("Share password incorrect.");
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not use this password.");
    } finally {
      if (!controller.signal.aborted) {
        const next = generation + 1;
        queryClient.removeQueries({ queryKey: publicShareKey(id) });
        if (latest) queryClient.setQueryData(publicShareMetadataKey(id, next), latest);
        setGeneration(next);
        setPending(false);
      }
    }
  }
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto max-w-5xl space-y-7">
        <div className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Link2 className="size-5" />
          fdrive
        </div>
        {metadata.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading shared link…
          </p>
        ) : metadata.isError ? (
          <Card>
            <CardHeader>
              <CardTitle>Share unavailable</CardTitle>
              <CardDescription>{metadata.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-2">
                  <CardTitle className="break-words text-2xl">
                    {metadata.data.name || "Password-protected share"}
                  </CardTitle>
                  {metadata.data.description && (
                    <CardDescription className="whitespace-pre-wrap">
                      {metadata.data.description}
                    </CardDescription>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh share"
                  disabled={pending}
                  onClick={() => void metadata.refetch()}
                >
                  <RefreshCw />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-2 text-xs text-muted-foreground">
                <Badge variant="secondary">
                  {metadata.data.scope === "write" ? "Can upload" : "Shared files"}
                </Badge>
                {publicShareUsage(metadata.data) !== null && (
                  <span>{publicShareUsage(metadata.data)}</span>
                )}
                {metadata.data.expiresAt && (
                  <span>Expires {new Date(metadata.data.expiresAt).toLocaleString()}</span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {metadata.data.hasPassword && !shareUnavailable(metadata.data) && (
                <form
                  onSubmit={(event) => void submitPassword(event)}
                  className="rounded-lg border bg-muted/20 p-4"
                >
                  <Field>
                    <FieldLabel htmlFor="public-share-password">Share password</FieldLabel>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="public-share-password"
                        type="password"
                        autoComplete="current-password"
                        maxLength={1024}
                        className="min-w-0 flex-1"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={pending}
                      />
                      <Button type="submit" disabled={pending || password.length === 0}>
                        {pending ? "Applying…" : "Use password"}
                      </Button>
                    </div>
                    <FieldDescription>
                      {metadata.data.credentialPresent
                        ? "Replace the password here if access is denied."
                        : "Enter the password supplied with this link. Access is checked when you browse, download, or upload."}
                    </FieldDescription>
                  </Field>
                </form>
              )}
              {error && <FieldError>{error}</FieldError>}
              <SharedContents
                id={id}
                path={path}
                share={metadata.data}
                generation={generation}
                pending={pending}
                uploads={uploads}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
