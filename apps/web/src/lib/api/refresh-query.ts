import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Refetches `queryKey` after a change. An in-flight request is cancelled
 * first: a first load that started before the change would otherwise answer
 * for the refresh with data from before it.
 */
export async function refreshQuery(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}
