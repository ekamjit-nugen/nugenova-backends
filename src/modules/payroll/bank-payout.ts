/**
 * Bank payout (salary disbursement) file — pure functions.
 *
 * Turns a finalized month's payslips + each employee's bank account into a
 * generic NEFT bulk-transfer CSV that finance uploads to their bank's portal to
 * pay everyone's NET salary in one go. Employees without complete bank details
 * are reported separately (skipped) so HR can fill them in.
 */

export interface PayoutBeneficiary {
  name: string;
  accountHolder?: string | null;
  accountNumber?: string | null;
  ifsc?: string | null;
  bankName?: string | null;
  netPay: number;
}

export interface PayoutFile {
  filename: string;
  mimeType: string;
  content: string;
  /** Beneficiaries included in the file. */
  count: number;
  /** Total amount to be transferred (rupees). */
  totalAmount: number;
  /** Names of employees skipped for missing/incomplete bank details. */
  skipped: string[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
function money2(n: number): number {
  return Math.round((n || 0) * 100) / 100;
}

/** A beneficiary is payable only with an account number, IFSC and a positive net. */
export function isPayable(b: PayoutBeneficiary): boolean {
  return !!b.accountNumber && !!b.ifsc && b.netPay > 0;
}

export function buildPayoutFile(beneficiaries: PayoutBeneficiary[], month: number, year: number): PayoutFile {
  const reference = `Salary ${MONTH_NAMES[month - 1]?.slice(0, 3) ?? month}-${year}`;
  const payable = beneficiaries.filter(isPayable);
  const skipped = beneficiaries.filter((b) => !isPayable(b)).map((b) => b.name);

  const header = [
    'Beneficiary Name', 'Account Number', 'IFSC Code', 'Amount', 'Transaction Type', 'Reference', 'Bank Name',
  ];
  const body = payable.map((b) => [
    b.accountHolder || b.name,
    b.accountNumber || '',
    b.ifsc || '',
    money2(b.netPay),
    // NEFT for larger amounts, IMPS is fine for small — leave NEFT as the safe default.
    'NEFT',
    reference,
    b.bankName || '',
  ]);
  const totalAmount = money2(payable.reduce((t, b) => t + b.netPay, 0));
  const totals = ['TOTAL', '', '', totalAmount, '', '', ''];

  return {
    filename: `salary-payout-${year}-${String(month).padStart(2, '0')}.csv`,
    mimeType: 'text/csv',
    content: csv([header, ...body, totals]),
    count: payable.length,
    totalAmount,
    skipped,
  };
}
