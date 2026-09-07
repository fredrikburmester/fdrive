import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { accountTransition } from "./transition";

/** An initial fetch with no cached data must finish cancelling before its replacement starts. */
export async function refreshIdentityQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  transition: Pick<typeof accountTransition, "getSnapshot"> = accountTransition,
): Promise<void> {
  const started = transition.getSnapshot();
  if (started.pending) return;
  await queryClient.cancelQueries({ queryKey });
  const current = transition.getSnapshot();
  if (current.pending || current.generation !== started.generation) return;
  await queryClient.invalidateQueries({ queryKey });
}
