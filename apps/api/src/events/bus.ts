import type { FsEvent, JobEvent } from "@fdrive/contracts";

/**
 * What flows through the bus: an `FsEvent` (which already carries its own
 * `identityId`), or a `JobEvent` paired with the identity it belongs to
 * (the wire `JobEvent` shape has no `identityId` of its own, since a job
 * belongs to one identity only and doesn't need to say so on every event;
 * `events/routes.ts` strips this field before it reaches the client).
 */
export type BusEvent = FsEvent | (JobEvent & { identityId: string });

export type BusEventHandler = (event: BusEvent) => void;

export interface EventBus {
  /** Publishes an event to every subscriber whose identity matches `event.identityId`. */
  publish(event: BusEvent): void;
  /**
   * Registers `handler` for every future event whose `identityId` matches
   * `filter.identityId`. Returns an unsubscribe function; calling it more
   * than once is a no-op.
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
 * Builds an in-process event bus for `/api/v1/events` (SSE): publishing an
 * `FsEvent` calls every handler subscribed to that event's identity.
 * Handler errors are swallowed so one broken subscriber (for example, a
 * client that disconnected mid-write) never breaks delivery to the others.
 */
export function createEventBus(): EventBus {
  const subscriptions = new Set<Subscription>();

  return {
    publish(event: BusEvent): void {
      for (const subscription of subscriptions) {
        if (subscription.identityId === event.identityId) {
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
