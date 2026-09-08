---
module: vertical
title: Vertical Pack — one platform, many verticals by config
owner: platform
status: live
phase: Wave A (institutional-platform foundation)
addedAt: 2026-09-08
---

# Vertical Pack (§04/§12)

The vertical is a **CONFIG object, not a fork**. The same modules, entities and
guards serve a company, a school, a college and a coaching centre; a *pack* only
changes three things:

1. the **vocabulary** the UI renders (Company→Institution, Employee→Student,
   Department→Grade/Faculty/Batch…),
2. **which modules** are enabled for the org, and
3. the org's **AI tier ceiling** (0–3, §09).

Nothing here forks the product — it re-labels and gates it.

## The two columns (on `organizations`)

- **`orgType`** — `company | school | college | coaching`, `NOT NULL DEFAULT
  'company'`. The default backfills every existing org, so nothing about a
  business tenant changes. Migration `1788033000000-VerticalPack`.
- **`verticalPack`** — jsonb, nullable. A per-org OVERRIDE
  `{ vocabulary?, enabledModules?, aiTierCeiling? }` layered on top of the
  orgType default. Null = the default verbatim.

## Resolution (`VerticalPackService`)

`resolvePack(orgId)` returns the EFFECTIVE pack = the orgType default deep-merged
with the org's override:

- `vocabulary` — default map, then the override map spread over it.
- `enabledModules` — the override list if non-empty, else the default list.
- `aiTierCeiling` — **an override may only LOWER it, never raise it** above the
  vertical's default. A school (default ceiling 1) cannot grant itself tier 3 by
  editing its own pack — the resolver clamps with `min(override, default)` and
  `setPack` rejects an out-of-range value.

Convenience reads: `isModuleEnabled(orgId, key)` and `aiTierCeiling(orgId)`.

### Default packs (`vertical-packs.ts`)

| orgType  | Organization→ | Member→ | Department→ | AI ceiling |
|----------|---------------|---------|-------------|------------|
| company  | Company       | Employee| Department  | 3          |
| school   | Institution   | Student | Grade       | **1** (K-12 minors) |
| college  | Institution   | Student | Faculty     | 2          |
| coaching | Academy       | Student | Batch       | 3          |

Education packs enable the education modules (`academic`, `lms`, `guardian`) on
top of the core HR/ops set. K-12's ceiling of 1 is the §09/§12 rule: minors get
assistive AI only; tiers 2–3 require recorded guardian consent (the guardian
module's consent ledger is the mechanism that lifts it).

## Roles + resource keys (education)

`default-roles.ts` gains `EDUCATION_ROLES` + `EDUCATION_RESOURCES` — **additive
exports**, NOT part of `SYSTEM_ROLES`/`DEFAULT_ROLES`, so a company org's seeding
is untouched. They reuse the existing role matrix (`RoleEntity` +
`{resource, actions[]}`); the matrix engine is unchanged.

Seeded roles (enforced tier in brackets): Principal (admin), Registrar (manager),
HoD (manager), Teacher (employee), Counsellor (employee), Warden (manager),
Librarian (employee), Accountant (manager), Student (viewer), Guardian (viewer).

`VerticalPackService.seedEducationRoles(orgId, actorId)` seeds them idempotently
(mirrors `OrgRoleService.seedDefaults`), and `setPack` calls it automatically
when an org becomes (or already is) an education vertical.

## Routes

```
GET /vertical/pack   resolved effective pack for the caller's org   (any member)
PUT /vertical        set orgType and/or override                    (owner/admin)
```

`GET /vertical/pack` uses `JwtAuthGuard` only — the UI needs its vocabulary, so
any authenticated member of the org may read it. `PUT /vertical` adds
`VerticalAdminGuard` (owner/admin), and the org is ALWAYS the JWT's own — never
taken from the client, so org A can't repack org B.

## Tests

- `vertical-pack.service.spec.ts` — company default unchanged, school relabel +
  module enable, coaching/college ceilings, override merge, ceiling-only-lowers,
  orgType validation, education-role seeding (idempotent) (unit, no DB).
- `features/vertical.feature` + `vertical.e2e-spec.ts` — default company pack,
  admin switch to school (+ seeded roles asserted from the DB), employee 403,
  and the ceiling clamp over HTTP.

## Migrations

- `1788033000000-VerticalPack` — `org_type` + `vertical_pack` on `organizations`
  (both `ADD COLUMN IF NOT EXISTS`, backfilled by the `company` default).

Registered in `test/global-setup.ts` (migrations array; the columns live on the
already-registered `OrganizationEntity`) and wired into `app.module.ts` as
`VerticalModule`.

## Deferred (out of Wave A scope)

- Enforcing `enabledModules` as a hard feature gate on each module's routes (the
  pack DECLARES enablement; wiring every module to consult it is later work).
- Consuming `aiTierCeiling` in an AI runtime (no AI runtime exists yet — §11).
- A super-admin surface to set orgType at provisioning time (today it is set
  post-provision by the org admin via `PUT /vertical`).
