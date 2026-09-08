---
module: platform-events
title: Domain Event-Bus Foundation
owner: platform
status: live
phase: Wave A (institutional-platform foundation)
addedAt: 2026-09-08
---

# Domain Event-Bus Foundation (§08 layer 1)

The **emit seam** for the whole platform. §08's automation stack is layered:
layer 1 is *"every module emits typed domain events"*; the nudge/digest/workflow
listeners are layers above it. This module ships **only layer 1** — the typed
emitter and the event catalogue. **Nothing subscribes yet**, by design: modules
start emitting now so that when the automation layer lands it binds to a stream
that already exists (retrofitting emits across every module later is the same
kind of rewrite the calendar/tz-day anchors avoided).

## What's here

- **`domain-events.ts`** — the authoritative event catalogue. `DOMAIN_EVENTS` is
  a const map of stable keys → wire names (`attendance.marked`,
  `attendance.shortfall`, `fee.overdue`, `enquiry.created`, `enquiry.stale`,
  `assessment.graded`, `document.expiring`, `admission.confirmed`,
  `enrolment.created`). Each has a payload interface, and `DomainEventPayloads`
  maps name → payload so `emit` is type-checked at the call site. Every payload
  extends `DomainEventBase` (`organizationId` for tenant routing, optional
  `occurredAt`, optional `actorId`).
- **`DomainEventsService`** — a thin wrapper over `@nestjs/event-emitter`'s
  `EventEmitter2`. `emit(name, payload)`:
  - is **generic** — a payload not matching the event's declared shape is a
    build error;
  - stamps a **consistent envelope** `{ ...payload, event, occurredAt }` so a
    future listener never reconstructs which/when;
  - **never throws** — a listener or bus error is caught and logged, so an
    emitted event can never break the business transaction that produced it.
- **`PlatformEventsModule`** — `@Global`, registers `EventEmitterModule.forRoot()`
  **once** (like `ScheduleModule` in `app.module.ts` — feature modules must not
  call `forRoot` again) and exports `DomainEventsService` app-wide.

## Naming rules

Wire names are `<aggregate>.<pastTenseFact>` and are **append-only**: once shipped,
listeners depend on them, so evolve via a new name + deprecation, never by
editing an existing one. Add new events to `DOMAIN_EVENTS`, give them a payload
interface, and register the pair in `DomainEventPayloads`.

## How a module emits

`PlatformEventsModule` is global, so inject the service and call it:

```ts
constructor(private readonly events: DomainEventsService) {}
// ...
this.events.emit(DOMAIN_EVENTS.ENROLMENT_CREATED, {
  organizationId: orgId,
  enrolmentId: saved.id,
  classId,
  studentMembershipId: dto.studentMembershipId,
  actorId,
});
```

### Proof point — `enrolment.created`

`LmsService.enrol` emits `enrolment.created` after a NEW enrolment is persisted
(not on a re-enrol of a withdrawn row). To keep the existing DB-less
`lms.service.spec.ts` green, `LmsService` injects `DomainEventsService` with
`@Optional()` and calls it through optional-chaining — so the unit spec (which
provides no bus) still passes, while the booted app always has the global
provider. This is the only wired emit so far; the rest of the catalogue is ready
for its owning module to adopt.

## Tests

- `domain-events.service.spec.ts` — envelope stamping, `occurredAt` passthrough,
  the never-throws guarantee, and that the catalogue exposes every plan event
  (unit, mocked `EventEmitter2`, no DB).

## Deferred (out of Wave A scope)

- Any **listener** (nudges, digests, workflow rules) — layer 2+.
- A durable/outbox event log for replay and cross-process fan-out (today the bus
  is in-process only).
- Adopting the emit in the other modules (attendance/fees/admissions/…): the
  names and payloads are defined; each module wires its own emit as it lands.
