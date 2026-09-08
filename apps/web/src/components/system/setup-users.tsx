"use client";

import type { SetupUserInventoryResponse } from "@fdrive/contracts";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api/client";
import { describeApiError } from "@/lib/api/errors";

/** Administrative credentials stay in this mounted form only; never cached as query variables. */
export function SetupUsers() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [result, setResult] = useState<SetupUserInventoryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function inspect(offset = 0) {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await apiClient.setupUserInventory({
          username,
          password,
          limit: 50,
          offset,
          ...(otp ? { otp } : {}),
        }),
      );
    } catch (error) {
      setError(describeApiError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Inspect SFTPGo users</CardTitle>
        <CardDescription>
          Optional. Use a SFTPGo administrator with permission to view users. Your file-user login
          cannot list other users.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This only reads the user list. Credentials are discarded when you leave this step. Manage
          users, passwords, and quotas in SFTPGo WebAdmin.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="inventory-user">SFTPGo admin username</FieldLabel>
            <Input
              id="inventory-user"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="inventory-password">SFTPGo admin password</FieldLabel>
            <Input
              id="inventory-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="inventory-otp">One-time code (if required)</FieldLabel>
          <Input
            id="inventory-otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(event) => setOtp(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || !username.trim() || !password}
            onClick={() => void inspect()}
          >
            {busy ? "Checking…" : "List users"}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setPassword("");
              setOtp("");
              setUsername("");
            }}
          >
            Forget credentials
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {result ? (
          result.ok ? (
            <div className="space-y-3">
              <p className="text-sm" role="status">
                {result.users.length
                  ? "Users visible to this SFTPGo administrator"
                  : "No users on this page."}
              </p>
              {result.users.map((user) => (
                <div className="flex justify-between gap-2 text-sm" key={user.username}>
                  <span>{user.username}</span>
                  <Badge variant="secondary">{user.status}</Badge>
                </div>
              ))}
              {result.nextOffset !== null ? (
                <Button
                  variant="outline"
                  disabled={busy || !password}
                  onClick={() => void inspect(result.nextOffset ?? 0)}
                >
                  Next page
                </Button>
              ) : null}
            </div>
          ) : (
            <p role="status" className="text-sm">
              {result.reason === "denied"
                ? "SFTPGo denied user discovery. Check admin credentials and view-user permission, or continue without a user list."
                : "User discovery is unavailable. You can continue setup and retry later."}
            </p>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
