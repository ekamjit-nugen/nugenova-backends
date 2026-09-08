import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  DomainEventEnvelope,
  DomainEventName,
  DomainEventPayloads,
} from './domain-events';

/**
 * DomainEventsService — §08 layer 1: the thin, typed wrapper every module emits
 * through. It sits on `@nestjs/event-emitter`'s `EventEmitter2` and exists to
 * give three guarantees the raw emitter does not:
 *
 *  1. **Type safety** — `emit(name, payload)` is generic over the
 *     `DomainEventPayloads` map, so a payload that doesn't match the event's
 *     declared shape is a compile error at the call site.
 *  2. **Consistent envelope** — every listener receives the payload plus a
 *     resolved `{ event, occurredAt }`, so routing/audit never has to reconstruct
 *     which event fired or when.
 *  3. **Never throws** — emitting a domain event is a side-channel; a bug in (a
 *     future) listener, or the bus itself, must NEVER break the business
 *     transaction that emitted it. Errors are caught and logged, never rethrown.
 *
 * NOTHING subscribes yet (per the plan) — this is the seam the automation layer
 * binds to later. Emitting is synchronous best-effort fire-and-forget.
 */
@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Emit a typed domain event. Returns whether at least one listener received it
   * (false is normal today — nothing subscribes). Safe to call inside a request
   * path: it swallows and logs any error instead of propagating.
   */
  emit<E extends DomainEventName>(
    event: E,
    payload: DomainEventPayloads[E],
  ): boolean {
    try {
      const envelope: DomainEventEnvelope<E> = {
        ...payload,
        event,
        occurredAt: payload.occurredAt ?? new Date(),
      };
      return this.emitter.emit(event, envelope);
    } catch (err) {
      // A domain event must never break the transaction that produced it.
      this.logger.error(
        `Failed to emit domain event '${event}': ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
      return false;
    }
  }
}
