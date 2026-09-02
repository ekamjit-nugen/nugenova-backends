/**
 * Payroll computation — pure, deterministic functions (no DB, no I/O) so the
 * money math is unit-testable in isolation. Ported from the legacy Nugenova
 * "simple" payslip path (`simple-payslip.service` / `resolveSimpleLop`), adapted
 * to Nexora's leave-type semantics.
 *
 * UNIT CONVENTION: everything is in RUPEES (never paise). The legacy code carried
 * a paise/rupee bug that zeroed out amounts — do not reintroduce any ×100 / ÷100.
 *
 * LOP model (cleaner than legacy's "monthly allowance"): a day of pay is lost for
 *   - each unaccounted working day (absent / never clocked in), and
 *   - each approved LEAVE day whose type is loss-of-pay (`lop`), and
 *   - half of each half-day.
 * Paid leave (casual/sick/earned/…) is full-pay and never docks salary — Nexora's
 * leave types already encode paid-vs-unpaid, so payroll just honours them.
 */

export interface LopInput {
  /** Business days in the pay period the employee is entitled to (weekdays −
   *  holidays, from their joining date within the period). */
  workingDays: number;
  /** Full days present (from attendance). */
  presentDays: number;
  /** Half days present (each = 0.5 pay, 0.5 LOP). */
  halfDays: number;
  /** Approved PAID leave days in the period (casual/sick/earned/…). */
  paidLeaveDays: number;
  /** Approved LOP-type leave days in the period (INCLUDES over-allowance excess). */
  lopLeaveDays: number;
  /** Of `lopLeaveDays`, the portion that is paid-type leave taken BEYOND policy
   *  (display only — already counted inside `lopLeaveDays`). */
  excessLeaveDays?: number;
  /**
   * Whether unaccounted working days should be docked as absence (LOP). Default
   * true. Set false for orgs that don't run attendance-based payroll — then only
   * explicit LOP-type leave + half-days dock, and everyone is assumed present
   * otherwise (avoids paying net 0 to every employee when no clock-in data exists).
   */
  dockUnaccounted?: boolean;
}

export interface LopResult {
  workingDays: number;
  presentDays: number;
  halfDays: number;
  paidLeaveDays: number;
  lopLeaveDays: number;
  /** Paid-type leave taken beyond the policy allowance (subset of lopLeaveDays). */
  excessLeaveDays: number;
  /** Working days with no attendance/leave to explain them → unpaid. */
  absentDays: number;
  /** Total loss-of-pay days (absent + lop-leave + ½·half), capped at workingDays. */
  lopDays: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Resolve loss-of-pay days for a pay period. Unaccounted working days (not
 * present, not on leave) are treated as absent → LOP. Half-days contribute half a
 * LOP day. Everything is clamped so LOP never exceeds the working days.
 */
export function resolveLop(input: LopInput): LopResult {
  const workingDays = Math.max(0, input.workingDays);
  const presentDays = Math.max(0, input.presentDays);
  const halfDays = Math.max(0, input.halfDays);
  const paidLeaveDays = Math.max(0, input.paidLeaveDays);
  const lopLeaveDays = Math.max(0, input.lopLeaveDays);

  // Days already explained (a half-day counts as a present day for accounting).
  const accounted = presentDays + halfDays + paidLeaveDays + lopLeaveDays;
  const absentDays = Math.max(0, round2(workingDays - accounted));

  // Unaccounted days only dock when attendance-based LOP is on (default). Otherwise
  // the employee is assumed present and only explicit LOP-leave + half-days dock.
  const dockedAbsence = input.dockUnaccounted === false ? 0 : absentDays;
  const lopDays = Math.min(workingDays, round2(dockedAbsence + lopLeaveDays + 0.5 * halfDays));

  return {
    workingDays,
    presentDays,
    halfDays,
    paidLeaveDays,
    lopLeaveDays,
    excessLeaveDays: Math.max(0, round2(input.excessLeaveDays ?? 0)),
    absentDays,
    lopDays,
  };
}

export interface PayslipComputation {
  monthlySalary: number;
  workingDays: number;
  lopDays: number;
  payableDays: number;
  perDayPay: number;
  lopDeduction: number;
  grossEarnings: number;
  totalDeductions: number;
  netPay: number;
}

/**
 * Compute a simple payslip: monthly salary minus a per-day LOP deduction.
 * `perDayPay = salary / workingDays`; net is clamped ≥ 0.
 */
export function computeSimplePayslip(monthlySalary: number, lop: LopResult): PayslipComputation {
  const salary = Math.max(0, round2(monthlySalary));
  const workingDays = lop.workingDays;

  // No payable working days in the period (e.g. the salary only takes effect after
  // this month, or the whole window is weekends/holidays) ⇒ nothing is earned.
  if (workingDays <= 0) {
    return {
      monthlySalary: salary,
      workingDays: 0,
      lopDays: 0,
      payableDays: 0,
      perDayPay: 0,
      lopDeduction: 0,
      grossEarnings: 0,
      totalDeductions: 0,
      netPay: 0,
    };
  }

  const perDayPay = round2(salary / workingDays);
  const lopDeduction = Math.min(salary, round2(perDayPay * lop.lopDays));
  const payableDays = round2(workingDays - lop.lopDays);
  const netPay = Math.max(0, round2(salary - lopDeduction));

  return {
    monthlySalary: salary,
    workingDays,
    lopDays: lop.lopDays,
    payableDays,
    perDayPay,
    lopDeduction,
    grossEarnings: salary,
    totalDeductions: lopDeduction,
    netPay,
  };
}

/** Indian-format the rupee amount in words (for the payslip). Integer rupees. */
export function rupeesInWords(amount: number): string {
  const n = Math.round(Math.max(0, amount));
  if (n === 0) return 'Zero Rupees';
  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number): string => {
    if (x < 20) return ones[x];
    return `${tens[Math.floor(x / 10)]}${x % 10 ? ' ' + ones[x % 10] : ''}`;
  };
  const three = (x: number): string => {
    const h = Math.floor(x / 100);
    const r = x % 100;
    return `${h ? ones[h] + ' Hundred' + (r ? ' ' : '') : ''}${r ? two(r) : ''}`;
  };
  let num = n;
  const parts: string[] = [];
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  const hundred = num;
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (hundred) parts.push(three(hundred));
  return `${parts.join(' ').trim()} Rupees`;
}
