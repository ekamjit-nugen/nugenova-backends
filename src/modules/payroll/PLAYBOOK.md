---
module: payroll
title: Payroll (Payslips + Statutory)
owner: finance
status: live
phase: 2
migratedAt: 2026-08-31
source: nugenova-monolith/src/modules/payroll (simple + statutory paths)
---

# Payroll — Payslips + Statutory (Phase 2)

Per-employee **monthly salary** (optional **component breakdown**) → generate
monthly **payslips** (gross minus **loss-of-pay** and **statutory deductions**) →
employee self-service payslips. Ported from the legacy Nugenova payslip + statutory
paths. Amounts are in **RUPEES**. Person = `User` + `OrgMembership` (`userId` = auth id).

## Phase 2 — statutory + custom deductions (opt-in template library)

Deductions are **opt-in**: a fresh org enables nothing — take-home = gross until the
owner adds deductions from a **template library**. `deduction-templates.ts` describes
every deduction (PF/ESI/PT/LWF + VPF/NPS/Gratuity/Group Health·Life·Accident/TDS/Meal)
with what it does, how much (rate/amount summary), who pays, and a statutory flag; it's
served via the catalog (`/policies/payroll-catalog`). Adding a statutory template flips
its flag; adding a custom template seeds a `customDeductions` row from its defaults.
`defaultPayrollConfig()` is opt-in (flags off, states `none`) but still carries the
canonical rates so an added statutory line starts correct. `PUT /policies/payroll-config`
is a **partial merge** onto the current config (a partial PUT never silently disables).

Payslips itemise **earnings**, **deductions**, and **employer contributions**.

- **Salary components** — `salary_structures.components` jsonb (Basic/HRA/allowances).
  Gross = sum of components; empty ⇒ the whole salary is Basic. **Basic drives PF.**
- **Statutory engine** (`statutory.ts`, pure + unit-tested):
  - **PF** — `min(Basic, wageCeiling) × rate`, employee share deducted + employer
    share as a contribution (default 12% / 12%, ceiling ₹15,000).
  - **ESI** — `gross × rate` only when monthly gross ≤ ceiling (default 0.75% /
    3.25%, ceiling ₹21,000).
  - **Professional Tax** — state-slab lookup on gross (`PT_STATES`: MH/KA/WB/TN/TS/
    GJ/MP + `none`); MH's February bump handled.
  - **LWF** (Labour Welfare Fund) — state amounts applied only in the applicable
    months (`LWF_STATES`, e.g. MH ₹25/₹75 in Jun & Dec); off by default.
  - The PT/LWF **state pickers offer every Indian state + UT** (`INDIAN_STATES`, 36);
    a state with no encoded slab resolves to ₹0. Static list — no runtime API / npm dep.
  - Statutory runs on the **LOP-adjusted (earned)** wage: earned gross drives
    ESI/PT/LWF, the correspondingly-prorated Basic drives PF.
- **Custom deductions / contributions** (owner-defined, org-wide) — a list on the
  same policy row. Each has a **basis** (`fixed` ₹, `percent_gross`,
  `percent_earned_gross`, `percent_basic`) and an employee value (deducted) and/or
  employer value (contribution). Covers VPF, NPS, group insurance, gratuity, a
  flat/percent TDS, etc. Evaluated by `evalCustomItem`.
- **Per-employee recurring deductions** — `salary_structures.recurring_deductions`
  jsonb: fixed monthly employee-side recoveries (loan EMI, advance, fines) for one
  employee only; not prorated.
- **Owner-configurable through policy** — rates, ceilings, enable flags, PT/LWF state,
  and the custom list live on a `payroll`-category policy row (`extraConfig.payroll`),
  resolved via `PolicyService.getPayrollConfig`. Defaults + clamping (percent≤100,
  code `^[A-Z0-9_]{1,20}$`, ≤25 custom lines) in `policy/payroll-config.ts`. Nothing
  is hardcoded in the run path.
- **Net** = `gross − LOP − employeeStatutory − customEmployee − recurring`.

## Phase B — governed run lifecycle (maker-checker)

Payroll now runs as a **governed unit** (`payroll_runs` table). Direct
`payslips/generate` stays as the quick, ungoverned path (publishes `final`
immediately); the governed path is: `POST /payroll/runs` (open a draft, one live
run per month) → `…/process` (compute **draft** payslips, → review, roll-up totals)
→ `…/approve` (**separation of duties** — approver ≠ preparer, EXCEPT the org owner
as sole approver, recorded as an audit note) → `…/finalize` (draft payslips flip to
`final` + employees notified) → `…/cancel` (discards drafts). Payslips carry
`status` (`draft`|`final`) + `payrollRunId`; `myPayslips`/`listPayslips` only ever
return `final`, so drafts stay hidden until finalize. Migration
`PayrollRun1787920000000`. e2e `payroll-run.feature` (3): full lifecycle +
draft-hidden, can't-finalize-before-approve, @security employee-can't-drive.

## LOP model (cleaner than legacy)

A day's pay is lost for: each **unaccounted working day** (absent / never clocked
in), each approved **LOP-type leave** day, and **half** of each half-day. PAID
leave (casual/sick/earned/…) is full-pay — Nexora's leave types already encode
paid-vs-unpaid, so payroll honours them (no "monthly allowance" hack).

## LOP model (cleaner than legacy)

A day's pay is lost for: each **unaccounted working day** (absent / never clocked
in), each approved **LOP-type leave** day, and **half** of each half-day. PAID
leave (casual/sick/earned/…) is full-pay — Nexora's leave types already encode
paid-vs-unpaid, so payroll honours them (no "monthly allowance" hack).

- `workingDays` = weekdays − org holidays, from the salary's `effectiveFrom`
  within the month. **0 working days ⇒ net 0** (salary not yet effective).
- `perDayPay = salary / workingDays`; `lopDeduction = perDayPay × lopDays`
  (capped at salary); `net = max(0, salary − lopDeduction)`.
- All pure + unit-tested in `payroll-calc.ts` (`resolveLop`, `computeSimplePayslip`,
  `rupeesInWords`).

## Integration

- **Attendance** `getDaysSummary(org,user,start,end)` → `{workingDays, presentDays,
  halfDays}` (added to AttendanceService).
- **Leave** `leaveSummaryForPeriod(org,user,start,end)` → `{paidLeaveDays,
  lopLeaveDays}` split by leave type (added to LeaveService).
- **Notification** `payroll_payslip_ready` → each employee when their slip is generated.

## Endpoints (`/api/v1/payroll`, JWT + PayrollAccessGuard)

| Method | Path | Access | What |
|---|---|---|---|
| GET | `/payroll/salary/me` | any member | The caller's salary. |
| GET | `/payroll/payslips/my` | any member | The caller's payslips. |
| GET | `/payroll/payslips/:id` | any member (own-only unless manager) | One payslip. |
| GET | `/payroll/salaries` | payroll:view | Salaried roster. |
| GET | `/payroll/salary/:userId` | payroll:view | A member's salary. |
| PUT | `/payroll/salary/:userId` | payroll:edit | Set/revise salary (supersede-on-write). |
| POST | `/payroll/payslips/generate` | payroll:edit | Run a month (upsert one slip/employee/month). |
| GET | `/payroll/payslips` | payroll:view | Org payslips for a month. |

`payroll` is a permission resource (owner/admin/HR hold it). Undecorated routes =
self-service; `@RequirePermission('payroll',…)` = manager.

Statutory config is owner-managed on the **policy** module (gated `policies:view`/`edit`):

| Method | Path | What |
|---|---|---|
| GET | `/policies/payroll-catalog` | Opt-in defaults + PT/LWF-state options + deduction bases + the **template library**. |
| GET | `/policies/payroll-config` | The org's live PF/ESI/PT config (resolved). |
| PUT | `/policies/payroll-config` | Create/update the statutory config. |

## Data model

- **`salary_structures`** — per-employee monthly salary in rupees, effective-dated,
  one `isActive` per employee (supersede-on-write via `supersedes`). `components`
  jsonb = earning breakdown (empty ⇒ whole salary is Basic); `recurring_deductions`
  jsonb = this employee's fixed monthly recoveries.
- **`payslips`** — immutable monthly artifact, unique `(user, year, month)`;
  snapshots employee/org; `lopDetails` jsonb (working/present/half/paid-leave/
  lop-leave/absent/lop/payable days + perDayPay); `earnings`/`deductions`/
  `employerContributions` jsonb line items + `statutory` jsonb totals (PF/ESI/PT).
  PDF is a pure function of the row (rendered client-side via print for now —
  server pdfkit is a later phase).
- Statutory config is stored on a **`policy`** row (category `payroll`,
  applicableTo `all`) in `extraConfig.payroll` — no new payroll table.

Migrations `Payroll1787890000000` + `PayrollStatutory1787900000000` +
`PayrollRecurringDeductions1787910000000` (all registered in test/global-setup.ts).

## Rollback

Remove `PayrollModule` from app.module; the two tables are additive
(`migration:revert` drops them).

## Deferred (Phase 3+)

**TDS** (income-tax slabs + declarations); **OT** from attendance hours; statutory
**returns** (ECR/24Q/Form 16); bank payout/CSV; investment declarations, expenses, loans;
server-side PDF; analytics. Full-&-Final settlement — gratuity (Gratuity Act §4),
leave encashment, notice recovery — **does exist in the legacy** (`offboarding.schema.ts`)
and is deferred here, NOT absent upstream. (Corrects an earlier note in this file.)
See the payroll gap analysis for the full legacy-parity backlog + the two live
correctness fixes (leave clip — done; loan-recovery cap — pending).

## Scenarios & tests

`features/payroll.feature` + `payroll.e2e-spec.ts` (11 e2e): owner sets salary,
@security employee-can't-set / can't-run, no-attendance → fully docked (net 0),
paid-leave-all-month → no LOP + full gross, **statutory deductions reduce net**,
**owner turns statutory off via policy → net = gross**, **components drive earnings
+ PF on Basic**, **owner custom deduction applies to everyone**, **per-employee
recurring recovery**, @security can't-read-another's-payslip. Unit:
`payroll-calc.spec.ts` (10), `statutory.spec.ts` (16), `policy/payroll-config.spec.ts`
(11). Verified live: set component salary + loan recovery → configure PF/ESI/PT/LWF +
a custom line → run → itemised payslip.
