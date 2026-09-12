import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { accountTransition } from "./transition";

type Transition = Pick<typeof accountTransition, "getSnapshot" | "subscribe">;
const deferred = new WeakMap<Transition, Map<QueryClient, Map<string, QueryKey>>>();

function deferRefresh(
  client: QueryClient,
  key: QueryKey,
  transition: Transition,
  generation: number,
) {
  let clients = deferred.get(transition);
  if (!clients) {
    clients = new Map();
    deferred.set(transition, clients);
  }
  let keys = clients.get(client);
  if (!keys) {
    keys = new Map();
    clients.set(client, keys);
    const pendingKeys = keys;
    const pendingClients = clients;
    const unsubscribe = transition.subscribe(() => {
      const state = transition.getSnapshot();
      if (state.pending) return;
      unsubscribe();
      pendingClients.delete(client);
      if (state.generation !== generation) return;
      for (const pendingKey of pendingKeys.values()) {
        void refreshIdentityQuery(client, pendingKey, transition).catch(() => undefined);
      }
    });
  }
  keys.set(JSON.stringify(key), key);
}

/** Cancel stale work before refreshing; defer while switching, replay only if the switch fails. */
export async function refreshIdentityQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  transition: Transition = accountTransition,
): Promise<void> {
  const started = transition.getSnapshot();
  if (started.pending) {
    deferRefresh(queryClient, queryKey, transition, started.generation);
    return;
  }
  await queryClient.cancelQueries({ queryKey });
  const current = transition.getSnapshot();
  if (current.generation !== started.generation) return;
  if (current.pending) {
    deferRefresh(queryClient, queryKey, transition, started.generation);
    return;
  }
  await queryClient.invalidateQueries({ queryKey });
}
