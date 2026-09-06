"use client";

import type { ApiTokenSummary } from "@fdrive/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { claudeMcpAddCommand, connectorUrl } from "@/lib/account/connect-snippets";
import { CopyField } from "./copy-field";

export interface CreatedToken {
  readonly token: string;
  readonly item: ApiTokenSummary;
}

export interface TokenCreatedDialogProps {
  created: CreatedToken | null;
  onClose: () => void;
}

/**
 * Shown exactly once, right after a token is created: the raw secret, a
 * copy button, a warning that it will never be shown again, and "Connect
 * Claude" snippets that already embed the new token.
 */
export function TokenCreatedDialog({ created, onClose }: TokenCreatedDialogProps) {
  const publicUrl = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <Dialog open={created !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Token created</DialogTitle>
          <DialogDescription>
            Copy it now. For your security, fdrive does not store the raw token and cannot show it
            again.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>This is the only time you will see this token. Store it somewhere safe.</span>
            </div>
            <CopyField label="API token" value={created.token} />
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Connect Claude</span>
              <p className="text-xs text-muted-foreground">
                Run this in a terminal to add fdrive as an MCP server:
              </p>
              <CopyField
                label="claude mcp add command"
                value={claudeMcpAddCommand(publicUrl, created.token)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">claude.ai connector URL</span>
              <p className="text-xs text-muted-foreground">
                For claude.ai connectors, which cannot set a header. This URL is itself a secret.
              </p>
              <CopyField label="Connector URL" value={connectorUrl(publicUrl, created.token)} />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
