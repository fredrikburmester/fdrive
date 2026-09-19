"use client";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { activityRequest } from "@/lib/activity/api";
import { getTabIdentity } from "@/lib/api/client";

export function FileJourneyButton({ path }: { path: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function open() {
    const identityId = getTabIdentity();
    if (!identityId) return;
    setPending(true);
    try {
      const value = (await activityRequest(
        `/files/resolve?${new URLSearchParams({ identityId, path })}`,
      )) as { id: string };
      router.push(`/activity/files/${value.id}` as Route);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open file journey");
    } finally {
      setPending(false);
    }
  }
  return (
    <Button variant="outline" className="min-h-11" disabled={pending} onClick={() => void open()}>
      File journey
    </Button>
  );
}
