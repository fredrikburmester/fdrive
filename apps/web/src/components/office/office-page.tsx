"use client";
import { ApiClientError, type OfficeMode, type OfficeOpenResponse } from "@fdrive/contracts";
import { baseName } from "@fdrive/core";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/api/auth-queries";
import { describeApiError, isReauthRequired } from "@/lib/api/errors";
import { officeClientForIdentity } from "@/lib/api/office-queries";
import { type OfficeMessage, validOfficeDescriptor } from "@/lib/office/messages";
import {
  officeFolderHref,
  officeHostTarget,
  officeHref,
  renamedOfficePath,
} from "@/lib/office/route";
import { OfficeFrame } from "./office-frame";

export interface OfficePageProps {
  identityId: string;
  path: string;
  mode: OfficeMode;
}

export function OfficePage(props: OfficePageProps) {
  const me = useMe();
  if (me.isPending)
    return (
      <p role="status" className="p-6 text-muted-foreground text-sm">
        Checking access…
      </p>
    );
  if (!me.data?.identities.some((identity) => identity.id === props.identityId)) {
    return (
      <div className="space-y-3 p-6">
        <p role="alert">This connection is not available to your account.</p>
        <Button nativeButton={false} variant="outline" render={<Link href={"/files" as Route} />}>
          Back to files
        </Button>
      </div>
    );
  }
  return (
    <OfficeSession
      key={`${props.identityId}:${props.path}:${props.mode}`}
      {...props}
      isActiveIdentity={me.data.activeIdentityId === props.identityId}
    />
  );
}

function OfficeSession({
  identityId,
  path,
  mode,
  isActiveIdentity,
}: OfficePageProps & { isActiveIdentity: boolean }) {
  const router = useRouter();
  const client = useMemo(() => officeClientForIdentity(identityId), [identityId]);
  const [descriptor, setDescriptor] = useState<OfficeOpenResponse | null>(null);
  const [currentPath, setCurrentPath] = useState(path);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latestPath = useRef(path);
  const renameGeneration = useRef(0);
  const folderHref = isActiveIdentity ? officeFolderHref(currentPath) : "/files";

  // biome-ignore lint/correctness/useExhaustiveDependencies: A deliberate retry starts a new in-memory session.
  useEffect(() => {
    let active = true;
    const openPath = latestPath.current;
    setError(null);
    setReauth(false);
    setDescriptor(null);
    void client
      .officeOpen({ path: openPath, mode })
      .then((response) => {
        if (!active) return;
        if (!validOfficeDescriptor(response, identityId, openPath) || response.mode !== mode) {
          setError("The office session could not be verified. Reopen the document.");
          return;
        }
        setCurrentPath(response.path);
        setDescriptor(response);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setReauth(isReauthRequired(err));
        setError(
          err instanceof ApiClientError
            ? describeApiError(err)
            : "Office could not open this document. Try again or download it.",
        );
      });
    return () => {
      active = false;
      renameGeneration.current += 1;
    };
  }, [client, identityId, path, mode, attempt]);

  useEffect(() => {
    if (descriptor === null) return;
    const duration = Math.max(0, new Date(descriptor.expiresAt).getTime() - Date.now());
    const timeout = window.setTimeout(
      () => {
        renameGeneration.current += 1;
        setDescriptor(null);
        setError("This office session has expired. Reopen the document to continue.");
      },
      Math.min(duration, 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [descriptor]);

  async function handleMessage(message: OfficeMessage) {
    if (message.MessageId === "UI_Close") router.push(folderHref as Route);
    if (message.MessageId === "UI_Edit")
      router.push(officeHref(identityId, currentPath, "edit") as Route);
    if (message.MessageId === "UI_Hyperlink") {
      const target = officeHostTarget(message.Values.Url, window.location.origin, identityId);
      if (target !== null) router.push(target as Route);
    }
    if (message.MessageId === "File_Rename" && descriptor !== null) {
      const renamed = renamedOfficePath(currentPath, message.Values.NewName);
      if (renamed === null) return;
      const generation = ++renameGeneration.current;
      try {
        const confirmed = await client.officeOpen({ path: renamed, mode: "view" });
        if (
          generation !== renameGeneration.current ||
          confirmed.fileId !== descriptor.fileId ||
          !validOfficeDescriptor(confirmed, identityId, renamed)
        )
          return;
        latestPath.current = confirmed.path;
        setCurrentPath(confirmed.path);
        // Updating history preserves the active edit iframe and its lock.
        window.history.replaceState(null, "", officeHref(identityId, confirmed.path, mode));
      } catch {
        if (generation !== renameGeneration.current) return;
        setError("The new document name could not be confirmed. Reopen it from its folder.");
      }
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        breadcrumbs={
          <span className="truncate font-medium text-sm">
            {descriptor === null ? "Office" : baseName(currentPath)}
          </span>
        }
        actions={
          <>
            <Button
              nativeButton={false}
              variant="ghost"
              size="sm"
              render={<Link href={folderHref as Route} />}
            >
              <ArrowLeftIcon />
              {isActiveIdentity ? "Back to folder" : "Back to files"}
            </Button>
            <Button
              nativeButton={false}
              variant="ghost"
              size="sm"
              render={<a href={client.downloadUrl(currentPath)} download />}
            >
              <DownloadIcon />
              Download
            </Button>
          </>
        }
      />
      {error !== null && (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <p role="alert" className="text-sm">
            {error}
          </p>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Reopen document
          </Button>
          {reauth && (
            <Button nativeButton={false} render={<Link href="/login" />}>
              Sign in
            </Button>
          )}
        </div>
      )}
      {descriptor !== null ? (
        <OfficeFrame
          descriptor={descriptor}
          onMessage={(message) => {
            void handleMessage(message);
          }}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : (
        error === null && (
          <p role="status" className="p-6 text-muted-foreground text-sm">
            Opening document…
          </p>
        )
      )}
    </section>
  );
}
