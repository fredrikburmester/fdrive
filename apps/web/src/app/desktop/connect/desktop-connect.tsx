"use client";

import type { DesktopAccessMode, MeResponse } from "@fdrive/contracts";
import { deviceKeyFor, pairingCode } from "@fdrive/crypto";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { UnlockForm } from "@/components/encryption/unlock-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { describeApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/keys";
import { keyStore, useKeyState } from "@/lib/encryption/keys";
import { useEncryptionStatus } from "@/lib/encryption/queries";

/**
 * What approving does with the account key: nothing (no encryption, or a Mac
 * that cannot take a key), wait for the status, ask this browser to unlock
 * first, or give the Mac its copy.
 */
type KeyDelivery = "none" | "loading" | "locked" | "unlocked";

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
  // A Mac that sent its device recipient, with the pairing's nonce, can take a copy of the
  // account key. Its code is computed here from what the key is encrypted to, so a recipient
  // the server swapped in shows a code that differs from the Mac's.
  const device =
    request.data?.deviceRecipient !== undefined && request.data.nonce !== undefined
      ? { recipient: request.data.deviceRecipient, nonce: request.data.nonce }
      : null;
  const code = useQuery({
    queryKey: ["desktop-pairing", requestId, "code", device?.recipient, device?.nonce],
    enabled: device !== null,
    queryFn: () => pairingCode(device?.recipient ?? "", device?.nonce ?? ""),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const takesKey = device !== null && me.data.encryptedFolders;
  const status = useEncryptionStatus(takesKey);
  const keyState = useKeyState();
  const delivery: KeyDelivery = !takesKey
    ? "none"
    : status.isPending
      ? "loading"
      : status.data?.enabled === false
        ? "none"
        : keyState.status === "unlocked"
          ? "unlocked"
          : "locked";
  // A Mac app that cannot write is only ever granted read access.
  const approval = useMutation({
    mutationFn: async () => {
      const mode = request.data?.supportsWrites ? access : "read";
      const accountIdentity = delivery === "unlocked" ? keyStore.identity() : null;
      if (accountIdentity === null || device === null) {
        return apiClient.approveDesktopPairing(requestId, mode);
      }
      const deviceKey = await deviceKeyFor(accountIdentity, device.recipient);
      return apiClient.approveDesktopPairing(requestId, mode, deviceKey);
    },
  });
  const approved = approval.isSuccess || request.data?.approved;
  const shownCode = device === null ? request.data?.code : code.data;
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
                className="min-h-16 rounded-lg bg-muted p-4 text-center font-mono text-2xl tracking-widest"
                role="status"
                aria-label="Connection code"
              >
                {shownCode}
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
                Connections expire after one year and can be revoked from Settings → API tokens.
              </p>
              {delivery === "unlocked" && (
                <p className="text-sm text-muted-foreground">
                  This Mac also gets a copy of your encryption key, so it can open your encrypted
                  folders.
                </p>
              )}
              {delivery === "locked" && (
                <div className="flex flex-col gap-3 rounded-lg border p-3">
                  <p className="text-sm">
                    Unlock to give this Mac your encryption key, so it can open your encrypted
                    folders.
                  </p>
                  <UnlockForm />
                  <p className="text-sm text-muted-foreground">
                    If you allow it without unlocking, this Mac's encrypted folders stay locked
                    until you connect it again.
                  </p>
                </div>
              )}
              {approval.isError && <p role="alert">{describeApiError(approval.error)}</p>}
              <Button
                disabled={approval.isPending || shownCode === undefined || delivery === "loading"}
                onClick={() => approval.mutate()}
              >
                {approval.isPending ? "Connecting…" : "Allow this Mac"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
