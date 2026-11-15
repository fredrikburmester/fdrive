import type { FsEvent, IndexedEvent, JobEvent } from "@fdrive/contracts";

/**
 * What flows through the bus: an `FsEvent` for one login with the journal
 * position it came from, a `JobEvent` paired with the login it belongs to,
 * or an `IndexedEvent`, which names no path and goes to every subscriber.
 * `events/routes.ts` strips `identityId` and `position` before an event
 * reaches the client.
 */
export type BusEvent =
  | (FsEvent & { readonly identityId: string; readonly position: number })
  | (JobEvent & { readonly identityId: string })
  | IndexedEvent;

export type BusEventHandler = (event: BusEvent) => void;

export interface EventBus {
  /** Publishes an event to every subscriber of its identity, or to every subscriber for `indexed`. */
  publish(event: BusEvent): void;
  /**
   * Registers `handler` for every future event whose `identityId` matches
   * `filter.identityId`, and every `indexed` event. Returns an unsubscribe
   * function; calling it more than once is a no-op.
   */
  subscribe(filter: { identityId: string }, handler: BusEventHandler): () => void;
  /**
   * The number of active subscribers, optionally narrowed to one identity.
   * For tests: asserting a subscriber was added or removed.
   */
  subscriberCount(identityId?: string): number;
}

interface Subscription {
  readonly identityId: string;
  readonly handler: BusEventHandler;
}

/**
 * Builds an in-process event bus for `/api/v1/events` (SSE). Delivery is
 * synchronous, so once `publish` returns every subscriber has its event.
 * Handler errors are swallowed so one broken subscriber (for example, a
 * client that disconnected mid-write) never breaks delivery to the others.
 */
export function createEventBus(): EventBus {
  const subscriptions = new Set<Subscription>();

  return {
    publish(event: BusEvent): void {
      for (const subscription of subscriptions) {
        if (event.type === "indexed" || subscription.identityId === event.identityId) {
          try {
            subscription.handler(event);
          } catch {
            // A subscriber's own handler failing must never break delivery
            // to the others or throw back into the publisher.
          }
        }
      }
    },

    subscribe(filter: { identityId: string }, handler: BusEventHandler): () => void {
      const subscription: Subscription = { identityId: filter.identityId, handler };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },

    subscriberCount(identityId?: string): number {
      if (identityId === undefined) {
        return subscriptions.size;
      }
      let count = 0;
      for (const subscription of subscriptions) {
        if (subscription.identityId === identityId) {
          count += 1;
        }
      }
      return count;
    },
  };
}
