import {
  runtimeEventScopeMatches,
  type RuntimeEventEnvelope,
  type RuntimeEventScopeFilter,
} from "./event-envelope";

export type RuntimeEventSubscriber = (
  event: RuntimeEventEnvelope,
) => void | Promise<void>;

export interface RuntimeEventSubscription {
  id: number;
  unsubscribe(): void;
}

export interface RuntimeEventBusOptions {
  onSubscriberError?: (error: unknown, event: RuntimeEventEnvelope) => void;
}

interface SubscriberRecord {
  filter: RuntimeEventScopeFilter;
  subscriber: RuntimeEventSubscriber;
}

export class RuntimeEventBus {
  private nextSubscriptionId = 1;
  private readonly subscribers = new Map<number, SubscriberRecord>();

  constructor(private readonly options: RuntimeEventBusOptions = {}) {}

  subscribe(
    filter: RuntimeEventScopeFilter,
    subscriber: RuntimeEventSubscriber,
  ): RuntimeEventSubscription {
    const id = this.nextSubscriptionId++;
    this.subscribers.set(id, { filter, subscriber });

    return {
      id,
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  publish(event: RuntimeEventEnvelope): void {
    for (const [id, record] of this.subscribers) {
      if (!runtimeEventScopeMatches(record.filter, event.scope)) {
        continue;
      }

      try {
        const result = record.subscriber(event);
        if (isPromiseLike(result)) {
          result.catch((error: unknown) => {
            this.options.onSubscriberError?.(error, event);
            this.subscribers.delete(id);
          });
        }
      } catch (error) {
        this.options.onSubscriberError?.(error, event);
        this.subscribers.delete(id);
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "catch" in value && typeof (value as { catch?: unknown }).catch === "function";
}
