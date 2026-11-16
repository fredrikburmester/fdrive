"use client";

import type { DesktopAccessMode, MeResponse } from "@fdrive/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { describeApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/keys";

export function DesktopConnect({
  requestId,
  initialMe,
}: {
  requestId: string;
  initialMe: MeResponse;
}) {
  const me = useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => apiClient.me(),
    initialData: initialMe,
    staleTime: 0,
  });
  const identity = me.data.identity;
  const [access, setAccess] = useState<DesktopAccessMode>("read");
  const request = useQuery({
    queryKey: ["desktop-pairing", requestId],
    queryFn: () => apiClient.desktopPairing(requestId),
    retry: false,
  });
  // A Mac app that cannot write is only ever granted read access.
  const approval = useMutation({
    mutationFn: () =>
      apiClient.approveDesktopPairing(requestId, request.data?.supportsWrites ? access : "read"),
  });
  const approved = approval.isSuccess || request.data?.approved;
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{approved ? "Connection approved" : "Connect fdrive for Mac"}</CardTitle>
          <CardDescription>
            {approved
              ? "Return to the Mac app to open your locations in Finder."
              : "Choose what this Mac may do with your files."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {request.isPending && <p role="status">Loading connection request…</p>}
          {request.isError && <p role="alert">{describeApiError(request.error)}</p>}
          {request.data && !approved && (
            <>
              <p className="break-words text-sm">
                Requested by <strong>{request.data.deviceName}</strong>. Only approve if this code
                matches the one in your Mac app.
              </p>
              <p
                className="rounded-lg bg-muted p-4 text-center font-mono text-2xl tracking-widest"
                role="status"
                aria-label="Connection code"
              >
                {request.data.code}
              </p>
              <div className="min-w-0 break-words rounded-lg border p-3 text-sm">
                <p>{me.data.storageName}</p>
                <p className="text-muted-foreground">{identity.username}</p>
              </div>
              {request.data.supportsWrites && (
                <label className="flex flex-col gap-2 text-sm">
                  Access
                  <select
                    className="h-10 rounded-md border bg-background px-3"
                    value={access}
                    disabled={approval.isPending}
                    onChange={(event) => setAccess(event.target.value === "full" ? "full" : "read")}
                  >
                    <option value="read">Read only</option>
                    <option value="full">Read and write</option>
                  </select>
                </label>
              )}
              <p className="text-sm text-muted-foreground">
                {request.data.supportsWrites
                  ? "Write access lets this Mac change files where the storage supports safe writes. "
                  : "Read access only. This Mac cannot change your remote files. "}
                Connections expire after one year and can be revoked from Account → API tokens.
              </p>
              {approval.isError && <p role="alert">{describeApiError(approval.error)}</p>}
              <Button disabled={approval.isPending} onClick={() => approval.mutate()}>
                {approval.isPending ? "Connecting…" : "Allow this Mac"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
