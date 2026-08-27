---
module: policy
title: Policies & Work Rules
owner: people
status: live
phase: 3
migratedAt: 2026-08-26
source: nugenova-monolith/src/modules/policy
---

# Policies & Work Rules

The org's **rulebook** — and the foundation Attendance sits on. A **work-timing
policy** defines the working day (clock-in/out, grace, minimum hours); **WFH** and
**work-location** rules ride on it. Every employee is governed by exactly one
resolved timing policy, so **a policy must exist and apply before attendance is
recorded** — a default is seeded for every new org so this always holds.

## Attendance sits behind Policy

Attendance never hardcodes the working day. On every clock-in it asks Policy to
**resolve the governing policy** for that employee and reads:

- **work timing** → the "late" line (start + grace), half-day thresholds, night shift;
- **work location** → the office geo-fence (office ⇒ location required & inside the
  fence; home ⇒ anywhere; hybrid ⇒ recorded, never blocked);
- **WFH rules** → a WFH-declared clock-in must fall on an allowed day and under the
  monthly cap.

**Resolution precedence** (most specific wins), among active, non-deleted,
in-effect timing policies (`category ∈ working_hours | attendance | shift` with a
`workTiming.startTime`), minus per-user exclusions:

1. **specific** — `applicableTo: specific`, targeting the employee's userId
2. **department / designation** — matching the employee's department / role
3. **all** — the org-wide default

**A default is seeded at org creation** (`Standard Work Timing`, 09:00–18:00 IST,
15-min grace, applicableTo `all`) so every employee always has a governing policy.
Change it, or add a department/specific override, and attendance follows.

## Authorization

Same org-scoped model as attendance (`PolicyAccessGuard`): fail-closed on a
missing org (a platform super-admin has no org → 403; one org never sees
another's policies — this **fixes** the monolith's un-scoped version-history +
acknowledge reads). **Reads** (list / view / applicable / acknowledge) are open to
**any member** — every employee may read and acknowledge policies. **Authoring**
(`create` / `edit` / `delete` / `from-template`) needs `policies:*` (owner/admin or
a permScoped role).

## Overview & endpoints

All routes under `/api/v1`.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/policies` | policies:create | Create a policy — **saved as a draft** (`isActive:false`) unless activated. |
| GET | `/policies` | any member | List the org's policies. |
| GET | `/policies/applicable` | any member | The policies that apply to the caller. |
| GET | `/policies/summary` | policies:view | Owner dashboard: counts + outstanding acknowledgements. |
| GET | `/policies/:id` | any member | One policy. |
| GET | `/policies/:id/versions` | any member | Version-history snapshots (audit trail). |
| GET | `/policies/:id/acknowledgements` | policies:view | Compliance: who has vs must acknowledge. |
| POST | `/policies/:id/acknowledge` | any member | Acknowledge (records userId + version). |
| GET | `/policies/my-acknowledgements` | any member | The caller's acknowledgements. |
| PUT | `/policies/:id` | policies:edit | Update — snapshots the prior version + bumps `version` (re-arms ack). |
| PUT | `/policies/:id/active` | policies:edit | Activate / deactivate toggle — **no** version bump. |
| DELETE | `/policies/:id` | policies:delete | Soft-delete. |
| GET | `/policies/templates` | policies:create | The work-timing/location/WFH templates (full config). |
| POST | `/policies/from-template/:name` | policies:create | Clone a template into the org (also a draft). |

**Lifecycle:** a policy is created as a **draft** and does not govern attendance
(the resolver filters `isActive:true`) until the owner **activates** it via the
toggle. The org's auto-seeded default work-timing policy is created active so a
brand-new org always has a governing policy. Every content edit writes an
immutable **version snapshot** to `policy_versions`; a bump re-arms
acknowledgement (members who acked an older version show as "re-acknowledge").
Policies carry a rich-text HTML `description` and **document attachments**
(uploaded via `/media/upload`, referenced by id).

### Data model (entities → tables)

- **`policies`** — org rulebook. Attendance-governing config is first-class jsonb
  (`work_timing`, `work_location`, `wfh_config`); other category blobs live in
  `extra_config` until their modules migrate. Applicability =
  `applicable_to` (all|department|designation|specific) + `applicable_ids[]` +
  `excluded_employee_ids[]`. `version` bumps in place on edit.
- **`policy_acknowledgements`** — one row per (policy, employee=userId), org-scoped,
  UNIQUE (policy, employee) — fixes the monolith's un-scoped, non-unique ack.
- **`policy_versions`** — immutable snapshot per content edit (full policy JSON +
  version + who/when + change summary), for the audit trail.
- **`policies.attachments`** — jsonb array of document refs (fileId/name/mime/size)
  into the shared media/storage store.

## Migration status & steps

- **Status:** ✅ live on Postgres. Verified: CRUD, org-scoping, super-admin
  isolation (403), employee read-only (403 on write), permScoped `policies:create`
  authoring, version bump, soft-delete, acknowledgement — AND the full
  **attendance-governed-by-policy** suite (late/present driven by the policy,
  department override, WFH allowed-days + monthly cap, office geo-fence,
  WFH-not-geo-fenced).
- **Entities:** `PolicyEntity`, `PolicyAcknowledgementEntity`.
- **Migration:** `Policies1787810000000`.
- **Run:** `npm run migration:run`

## Rollback

Additive and reversible. `npm run migration:revert` drops both tables; remove
`PolicyModule` from `app.module.ts` and the seed call from `createOrganization`
(attendance then falls back to its safe default work-timing).

## Deferred (later phases, with their modules)

- **Leave / overtime / holiday / probation / onboarding / payroll** category
  configs — stored via `extra_config`, logic lands with those modules.
- **AI policy drafting** (`policy-ai`), a **rules engine**, and the **Work
  Preferences** write-through surface.
- **Version diffing / rollback** — snapshots are captured and viewable; restoring
  a prior version is a later add.

## Scenarios & tests

`features/policy.feature` (CRUD, org-scoping, super-admin isolation, RBAC,
acknowledgement) + `../attendance/features/attendance-policy.feature` (the
dependency: policy governs clock-in status, department override, WFH, geo-fence),
bound to supertest specs. Pure units: `util/policy-eligibility` (effective window +
applicability). Live CI status is merged into this playbook by `admin-playbooks`.
