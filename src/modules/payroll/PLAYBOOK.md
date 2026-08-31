---
module: payroll
title: Payroll (Simple Payslips)
owner: finance
status: live
phase: 1
migratedAt: 2026-08-31
source: nugenova-monolith/src/modules/payroll (simple path)
---

# Payroll — Simple Payslips (Phase 1)

Per-employee **monthly salary** → generate monthly **payslips** (salary minus a
per-day **loss-of-pay** deduction) → employee self-service payslips. Ported from
the legacy Nugenova "simple" payslip path (the monolith also has a "structured"
CTC + statutory engine — that's a later phase). Amounts are in **RUPEES**. Person
= `User` + `OrgMembership` (`userId` = auth id).

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

## Data model

- **`salary_structures`** — per-employee monthly salary in rupees, effective-dated,
  one `isActive` per employee (supersede-on-write via `supersedes`).
- **`payslips`** — immutable monthly artifact, unique `(user, year, month)`;
  snapshots employee/org; `lopDetails` jsonb (working/present/half/paid-leave/
  lop-leave/absent/lop/payable days + perDayPay). PDF is a pure function of the
  row (rendered client-side via print for now — server pdfkit is a later phase).

Migration `Payroll1787890000000` (registered in test/global-setup.ts).

## Rollback

Remove `PayrollModule` from app.module; the two tables are additive
(`migration:revert` drops them).

## Deferred (Phase 2+, legacy "structured" path)

Full CTC component breakdown; the PF/ESI/PT/TDS statutory engine + returns
(ECR/24Q/Form 16); maker-checker run lifecycle (draft→review→approve→finalize→pay);
bank payout/CSV; investment declarations, expenses, loans; server-side PDF;
analytics. Gratuity/F&F/encashment don't exist in the legacy either.

## Scenarios & tests

`features/payroll.feature` + `payroll.e2e-spec.ts` (6 e2e): owner sets salary,
@security employee-can't-set / can't-run, no-attendance → fully docked (net 0),
paid-leave-all-month → full net salary, @security can't-read-another's-payslip.
`payroll-calc.spec.ts` (10 unit). Verified live: set salary → run → payslip.
