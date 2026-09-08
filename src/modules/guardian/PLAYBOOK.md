---
module: guardian
title: Guardian Links & the Consent Ledger
owner: education
status: live
phase: Wave A (institutional-platform foundation)
addedAt: 2026-09-08
---

# Guardian Links & the Consent Ledger (§04, §09/§10)

Two things land here, both foundation for the education vertical's minor-data
handling:

1. **GuardianLink** — the guardian↔student graph (§04's client-portal pattern,
   recast for education).
2. **ConsentLedger** — the append-only, per-learner, per-purpose consent record
   that §09 AI tiers 2–3 and DPDP data-processing gate on.

No guardian-facing portal yet — these are the registrar-facing (owner/admin)
surfaces and the query API other modules will call.

## ⚠️ personType, both ways (the same guard the LMS relies on)

A `GuardianLink`'s two sides are constrained by `OrgMembership.personType`:

- the **guardian side MUST be `personType='guardian'`**, and
- the **student side MUST be `personType='student'`**.

Neither is expressible as a column constraint, so both live in `GuardianService`
(`assertPersonType`) — a staff/student id on the guardian side, or a
staff/guardian id on the student side, is a **400**. The unit spec is a
build-failing guard on both.

## GuardianLink (`guardian_links`)

`{ organizationId, guardianMembershipId, studentMembershipId, relationship,
isPrimary, deactivatedAt }`

- UNIQUE `(guardian, student)` — one link per pair.
- **At most one primary guardian per student** — promoting a link to `isPrimary`
  clears the flag on the student's other active links, in a transaction.
- **Unlink is SOFT** (`deactivatedAt` stamped), never a delete — so consent
  granted "by a guardian" keeps resolving in the audit trail. A later re-link
  flips the SAME row back (never violates the unique index).

## ConsentLedger (`consent_ledger`) — append-only

`{ organizationId, subjectMembershipId, purpose, basis, grantedByMembershipId,
grantedAt, revokedAt, revokedByMembershipId, version }`

- `purpose` is the thing consented to — e.g. `ai_tier_2`, `ai_tier_3`,
  `data_processing`. This is the field §09 checks before an AI action above the
  vertical's default ceiling.
- `basis` is `self` (the subject acting for themselves) or `guardian` (a linked
  guardian acting for a minor). The service **derives and authorizes** it:
  `grantedByMembershipId` must be either the subject (→ `self`) or a guardian
  **actively linked** to the subject (→ `guardian`) — otherwise **400**, so a
  stranger can never consent on a learner's behalf.
- **Append-only**: a grant is a NEW row; `recordConsent` is idempotent (an
  already-active record for the tuple is returned, not duplicated). A **revoke
  soft-stamps** `revokedAt` on every active record for `(subject, purpose)` — the
  row is never deleted, so the full who/what/when/withdrawn history survives
  (DPDP auditability). A re-grant after a revoke appends a fresh row.
- **`isConsented(org, subject, purpose)`** — the gate other modules call — is true
  iff an un-revoked record exists. Exported via `GuardianService`.

## Routes (all owner/admin — `GuardianAccessGuard`)

```
POST   /guardian/links                                   link guardian↔student
DELETE /guardian/links/:linkId                           soft-unlink
GET    /guardian/links?studentMembershipId=              a student's guardians
GET    /guardian/links?guardianMembershipId=             a guardian's students
POST   /guardian/consent                                 record consent (append)
POST   /guardian/consent/revoke                          revoke (soft)
GET    /guardian/consent/:subjectMembershipId            full ledger (active+revoked)
GET    /guardian/consent/:subjectMembershipId/check?purpose=   is-consented boolean
```

The org is ALWAYS the JWT's own — never taken from the client — so org A can't
read or mutate org B's links or consent (cross-org → 404/400).

## Tests

- `guardian.service.spec.ts` — personType both ways, self vs guardian consent,
  the linked-guardian authorization, append-only idempotence, soft revoke, and
  `isConsented` reflecting only un-revoked records (unit, no DB).
- `features/guardian.feature` + `guardian.e2e-spec.ts` — link creation, staff-
  as-student rejection (400), employee 403, the consent→check→revoke→check
  lifecycle, and unlinked-guardian rejection (400). Guardian/student memberships
  are inserted raw (personType set) as the future vertical would.

## Migrations

- `1788034000000-Guardian` — `guardian_links` + `consent_ledger` with their
  indexes (unique guardian/student pair; the consent lookup index).

Registered in `test/global-setup.ts` (entities + migrations arrays) and wired
into `app.module.ts` as `GuardianModule`.

## Deferred (out of Wave A scope)

- **Guardian portal auth** — OTP/session scoping so a guardian logs in and sees
  ONLY their linked wards (today the surfaces are admin-only; the graph exists,
  the guardian-facing read does not).
- **Consent copy/versioning** — `version` is stored but there is no library of
  consent documents to pin it to (mirrors the T&C library pattern; later).
- **Automatic tier enforcement** — `isConsented` is the gate, but no AI runtime
  consumes it yet (§11). §09 tiers 2–3 will call it when that runtime lands.
- Notifying a guardian on consent requests/changes (needs the guardian portal +
  the notification channels).
