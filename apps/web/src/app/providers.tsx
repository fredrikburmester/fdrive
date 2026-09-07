"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { refreshIdentityQuery } from "@/lib/account/invalidation";
import { queryKeys } from "@/lib/api/keys";
import { useUploadStore } from "@/lib/upload/store";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  // Replaces the upload store's default `onUploaded` (a raw refetch) with
  // one that invalidates the affected directory's cached listing, so a
  // finished upload updates the file browser through the same query cache
  // as every other mutation.
  useEffect(() => {
    useUploadStore.getState().setOnUploaded((parentPath) => {
      void refreshIdentityQuery(queryClient, queryKeys.fs.list(parentPath));
    });
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
