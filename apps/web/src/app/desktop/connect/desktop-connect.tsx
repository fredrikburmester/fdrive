"use client";

import type { MeResponse } from "@fdrive/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  const identities = me.data.identities;
  const [selected, setSelected] = useState<string[]>([]);
  const request = useQuery({
    queryKey: ["desktop-pairing", requestId],
    queryFn: () => apiClient.desktopPairing(requestId),
    retry: false,
  });
  const approval = useMutation({
    mutationFn: () => apiClient.approveDesktopPairing(requestId, selected),
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
              : "Choose which storage logins this Mac can browse and download."}
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
              <fieldset className="flex flex-col gap-3" disabled={approval.isPending}>
                <legend className="mb-2 text-sm font-medium">Storage logins</legend>
                {identities.map((identity) => (
                  <label
                    key={identity.id}
                    htmlFor={`desktop-${identity.id}`}
                    className="flex items-center gap-3 rounded-lg border p-3 text-sm"
                  >
                    <Checkbox
                      id={`desktop-${identity.id}`}
                      checked={selected.includes(identity.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked === true
                            ? [...current, identity.id]
                            : current.filter((id) => id !== identity.id),
                        )
                      }
                    />
                    <span className="min-w-0 break-words">
                      {identity.providerLabel}
                      <span className="block text-muted-foreground">{identity.username}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="text-sm text-muted-foreground">
                Read access only. This Mac cannot change your remote files. Connections expire after
                one year and can be revoked from Account → API tokens.
              </p>
              {approval.isError && <p role="alert">{describeApiError(approval.error)}</p>}
              <Button
                disabled={selected.length === 0 || approval.isPending}
                onClick={() => approval.mutate()}
              >
                {approval.isPending ? "Connecting…" : "Allow selected logins"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
