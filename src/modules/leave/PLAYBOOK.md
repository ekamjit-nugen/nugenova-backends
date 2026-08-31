---
module: leave
title: Leave Management
owner: people
status: live
phase: 1
migratedAt: 2026-08-31
source: nugenova-monolith/src/modules/leave
---

# Leave Management

Employees **apply** for leave; owner/HR **approve or reject**. Per-type
**balances** are granted up-front and **deducted at approval** (restored on
cancel). Ported from the Nugenova monolith to Postgres/TypeORM. Person =
`User` + `OrgMembership` (`userId` is the auth id — no separate HR Employee).

This is **Phase 1** — the core apply → decide → balance loop. Accrual,
carry-forward, encashment, the WFH→attendance materialisation, payroll LOP
split, and email one-click approvals are **Phase 2** (see **Deferred**). Note
the legacy accrual/carry-forward columns were *defined but never executed* — the
full annual allocation was granted up-front as `opening`, which is exactly what
Phase 1 reproduces.

## Leave types & balances

Nine catalog types (`leave-catalog.ts`): casual (12), sick (12), earned (15),
wfh (24), maternity (180), paternity (15), bereavement (5), comp_off (0), lop
(0). The default allocation is granted into the balance `opening` lazily on
first read of an employee-year. `lop` (loss-of-pay) is **not balance-tracked** —
it never deducts and never blocks. Invariant, recomputed on every mutation:
`available = opening + accrued + adjusted + carriedForward − used`.

## Lifecycle & rules

- **Apply** — owner/admin org-roles are blocked (they manage, not apply).
  Business-day count excludes **weekends AND holidays** (improvement over legacy,
  which ignored holidays — Nexora has the holiday calendar). Half-day forces 0.5
  and is single-day only. Overlap with any pending/approved leave → 409.
  Insufficient balance (tracked types) → 400. Fires `leave_requested` to managers.
- **Approve** — pending only. **Maker-checker**: can't decide your own leave
  unless owner/admin. Deducts `used`. Notifies applicant `leave_approved`.
- **Reject** — pending only, same maker-checker; records the reason; balance
  untouched; notifies `leave_rejected`.
- **Cancel** — the applicant (or a manager) cancels their pending/approved leave;
  an approved cancel **restores** the balance; notifies the approver
  `leave_cancelled`.

## Endpoints (`/api/v1/leaves`, JWT + LeaveAccessGuard)

| Method | Path | Access | What |
|---|---|---|---|
| GET | `/leaves/types` | any member | The leave-type catalog. |
| GET | `/leaves/my` | any member | The caller's leaves. |
| GET | `/leaves/balance` | any member | The caller's balance (auto-inits). |
| GET | `/leaves/stats` | any member | The caller's counts by status. |
| POST | `/leaves` | any member (owner/admin blocked in service) | Apply. |
| PUT | `/leaves/:id/cancel` | any member (own-only unless manager) | Cancel. |
| GET | `/leaves/:id` | any member (own-only unless manager) | One request. |
| GET | `/leaves` | leaves:view | Org-wide list. |
| GET | `/leaves/pending` | leaves:view | Approvals queue. |
| GET | `/leaves/balance/by-user/:userId` | leaves:view | A member's balance. |
| PUT | `/leaves/:id/approve` | leaves:edit | Approve (+ deduct balance). |
| PUT | `/leaves/:id/reject` | leaves:edit | Reject with a reason. |

Routes WITHOUT `@RequirePermission` are self-service; WITH it are the manager
surface. `leaves` is an existing permission resource (owner/admin/HR hold it).

## Data model

- **`leave_requests`** — org + userId + denorm name/email, leaveType, start/end
  (timestamptz day bounds), totalDays numeric(5,1), halfDay + halfDaySlot,
  reason, status (pending|approved|rejected|cancelled), reviewedBy/At/Note,
  isDeleted. Indexes (org,status)/(org,user)/(user,dates).
- **`leave_balances`** — one row per (userId, year) unique; `balances` jsonb of
  `{leaveType, opening, accrued, used, adjusted, carriedForward, available}`.

Migration `Leave1787880000000` (registered in test/global-setup.ts).

## Rollback

Remove `LeaveModule` from `app.module`; the `leave_requests`/`leave_balances`
tables are additive. `migration:revert` drops them.

## Deferred (Phase 2, with their dependency modules)

- **Accrual & carry-forward crons**, year rollover, opening pro-ration for
  mid-year joiners (dead in legacy too).
- **WFH leave → attendance materialisation** (approved WFH days count as worked).
- **Payroll**: paid-vs-LOP split, F&F encashment (needs Payroll).
- **Email one-click approve/reject** (signed-token public endpoint).
- **Owner-configurable leave types** via the policy `leaveConfig`.
- **Manual balance adjustments** (`adjusted`), reconciliation job.
- **Team leave calendar**, department-scoped manager views.

## Scenarios & tests

`features/leave.feature` + `leave.e2e-spec.ts` (11 e2e, jest-cucumber): balance
seeding, apply, weekend-aware counting, overlap 409, insufficient 400, approve
deducts, cancel restores, reject untouched, owner-cannot-apply, @security
employee-cannot-approve, lop-ignores-balance. `util/leave-days.util.spec.ts` (10
unit: business-day/holiday counting + overlap + dayKey). Verified live E2E:
apply (UI) → pending → owner approves → balance 12→11 + `leave_approved` notif.
