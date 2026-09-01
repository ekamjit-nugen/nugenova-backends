/**
 * Statutory registers & return exports (pure functions).
 *
 * These turn a month's finalized payslips into the register/return files a
 * finance team files with the authorities: a full payroll register plus
 * PF (ECR-shaped), ESI, PT and TDS (24Q Annexure I-shaped) registers.
 *
 * The *money* is authoritative — every amount is read straight off the
 * immutable payslip. The employee *identifiers* the portals need (UAN, PF/ESIC
 * number, PAN) are not yet stored on the person in Nexora, so those columns are
 * emitted blank for HR to fill in the portal. Nothing here is claimed to be a
 * ready-to-upload government file; they are filing-preparation exports.
 */

export type ReturnKind = 'register' | 'pf' | 'esi' | 'pt' | 'tds';

/** The slice of a payslip a register needs. Kept flat + serialisable. */
export interface ReturnRow {
  name: string;
  email: string;
  pan?: string | null;
  uan?: string | null;
  esicNumber?: string | null;
  pfNumber?: string | null;
  workingDays: number;
  payableDays: number;
  lopDays: number;
  grossEarnings: number;
  basic: number;
  lopDeduction: number;
  pfWage: number;
  pfEmployee: number;
  pfEmployer: number;
  pfEps: number;
  pfEpfEmployer: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  lwfEmployee: number;
  tds: number;
  otherDeductions: number;
  totalDeductions: number;
  netPay: number;
}

export interface ReturnFile {
  filename: string;
  mimeType: string;
  content: string;
  /** Rows the file summarises — for the API to report counts without re-parsing. */
  rowCount: number;
}

// ── CSV helpers ────────────────────────────────────────────────────────────────

/** RFC-4180 quote: wrap in quotes when the cell holds a comma, quote or newline. */
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function money(n: number): number {
  return Math.round((n || 0) * 100) / 100;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function periodTag(month: number, year: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ── Full payroll register ──────────────────────────────────────────────────────

export function payrollRegister(rows: ReturnRow[], month: number, year: number): ReturnFile {
  const header = [
    'Employee', 'Email', 'Working days', 'Payable days', 'LOP days',
    'Gross', 'Basic', 'LOP',
    'PF (employee)', 'PF (employer)', 'ESI (employee)', 'ESI (employer)',
    'Professional tax', 'LWF', 'TDS', 'Other deductions',
    'Total deductions', 'Net pay',
  ];
  const body = rows.map((r) => [
    r.name, r.email, r.workingDays, r.payableDays, r.lopDays,
    money(r.grossEarnings), money(r.basic), money(r.lopDeduction),
    money(r.pfEmployee), money(r.pfEmployer), money(r.esiEmployee), money(r.esiEmployer),
    money(r.professionalTax), money(r.lwfEmployee), money(r.tds), money(r.otherDeductions),
    money(r.totalDeductions), money(r.netPay),
  ]);
  const totals = [
    'TOTAL', '', '', '', '',
    money(sum(rows, 'grossEarnings')), money(sum(rows, 'basic')), money(sum(rows, 'lopDeduction')),
    money(sum(rows, 'pfEmployee')), money(sum(rows, 'pfEmployer')),
    money(sum(rows, 'esiEmployee')), money(sum(rows, 'esiEmployer')),
    money(sum(rows, 'professionalTax')), money(sum(rows, 'lwfEmployee')),
    money(sum(rows, 'tds')), money(sum(rows, 'otherDeductions')),
    money(sum(rows, 'totalDeductions')), money(sum(rows, 'netPay')),
  ];
  return {
    filename: `payroll-register-${periodTag(month, year)}.csv`,
    mimeType: 'text/csv',
    content: csv([header, ...body, totals]),
    rowCount: rows.length,
  };
}

// ── PF register (EPFO ECR fields) ──────────────────────────────────────────────

export function pfRegister(rows: ReturnRow[], month: number, year: number): ReturnFile {
  const covered = rows.filter((r) => r.pfWage > 0 || r.pfEmployee > 0);
  const header = [
    'UAN', 'Member name', 'Gross wages', 'EPF wages', 'EPS wages', 'EDLI wages',
    'EPF contribution (EE)', 'EPS contribution (ER)', 'EPF contribution (ER)',
    'NCP days', 'Refund of advances',
  ];
  // EPFO ECR takes gross/EPF/EPS/EDLI wages + the three contribution splits.
  const body = covered.map((r) => [
    r.uan || '', r.name,
    money(r.grossEarnings), money(r.pfWage), money(Math.min(r.pfWage, 15000)), money(r.pfWage),
    money(r.pfEmployee), money(r.pfEps), money(r.pfEpfEmployer),
    r.lopDays, 0,
  ]);
  const totals = [
    'TOTAL', '',
    money(sum(covered, 'grossEarnings')), money(sum(covered, 'pfWage')),
    money(covered.reduce((t, r) => t + Math.min(r.pfWage, 15000), 0)), money(sum(covered, 'pfWage')),
    money(sum(covered, 'pfEmployee')), money(sum(covered, 'pfEps')), money(sum(covered, 'pfEpfEmployer')),
    '', '',
  ];
  return {
    filename: `pf-ecr-register-${periodTag(month, year)}.csv`,
    mimeType: 'text/csv',
    content: csv([header, ...body, totals]),
    rowCount: covered.length,
  };
}

// ── ESI register ────────────────────────────────────────────────────────────────

export function esiRegister(rows: ReturnRow[], month: number, year: number): ReturnFile {
  const covered = rows.filter((r) => r.esiEmployee > 0 || r.esiEmployer > 0);
  const header = [
    'ESIC number', 'Member name', 'Payable days', 'ESI wages',
    'Employee contribution', 'Employer contribution', 'Total',
  ];
  const body = covered.map((r) => [
    r.esicNumber || '', r.name, r.payableDays, money(r.grossEarnings),
    money(r.esiEmployee), money(r.esiEmployer), money(r.esiEmployee + r.esiEmployer),
  ]);
  const totals = [
    'TOTAL', '', '', money(sum(covered, 'grossEarnings')),
    money(sum(covered, 'esiEmployee')), money(sum(covered, 'esiEmployer')),
    money(sum(covered, 'esiEmployee') + sum(covered, 'esiEmployer')),
  ];
  return {
    filename: `esi-register-${periodTag(month, year)}.csv`,
    mimeType: 'text/csv',
    content: csv([header, ...body, totals]),
    rowCount: covered.length,
  };
}

// ── PT register ──────────────────────────────────────────────────────────────────

export function ptRegister(rows: ReturnRow[], month: number, year: number): ReturnFile {
  const covered = rows.filter((r) => r.professionalTax > 0);
  const header = ['Employee', 'Email', 'Gross', 'Professional tax'];
  const body = covered.map((r) => [r.name, r.email, money(r.grossEarnings), money(r.professionalTax)]);
  const totals = ['TOTAL', '', money(sum(covered, 'grossEarnings')), money(sum(covered, 'professionalTax'))];
  return {
    filename: `pt-register-${periodTag(month, year)}.csv`,
    mimeType: 'text/csv',
    content: csv([header, ...body, totals]),
    rowCount: covered.length,
  };
}

// ── TDS register (Form 24Q Annexure I shape) ─────────────────────────────────────

export function tdsRegister(rows: ReturnRow[], month: number, year: number): ReturnFile {
  const covered = rows.filter((r) => r.tds > 0);
  const header = [
    'PAN', 'Deductee (employee)', 'Amount paid/credited (gross)', 'TDS deducted',
    'Section', 'Date of payment',
  ];
  // Salaries are deducted under section 192. Date left blank — the payout date.
  const body = covered.map((r) => [
    r.pan || '', r.name, money(r.grossEarnings), money(r.tds), '192', '',
  ]);
  const totals = ['TOTAL', '', money(sum(covered, 'grossEarnings')), money(sum(covered, 'tds')), '', ''];
  return {
    filename: `tds-24q-annexure1-${periodTag(month, year)}.csv`,
    mimeType: 'text/csv',
    content: csv([header, ...body, totals]),
    rowCount: covered.length,
  };
}

function sum(rows: ReturnRow[], key: keyof ReturnRow): number {
  return rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
}

// ── Dispatcher ──────────────────────────────────────────────────────────────────

export const RETURN_TYPES: { value: ReturnKind; label: string; description: string }[] = [
  { value: 'register', label: 'Payroll register', description: 'Full per-employee earnings & deductions for the month.' },
  { value: 'pf', label: 'PF (EPFO ECR)', description: 'Provident-fund wages & the EPF/EPS contribution split.' },
  { value: 'esi', label: 'ESI', description: 'ESI wages & employee/employer contributions (covered members).' },
  { value: 'pt', label: 'Professional tax', description: 'PT deducted per employee for the state.' },
  { value: 'tds', label: 'TDS (Form 24Q, Annexure I)', description: 'Income-tax deducted per employee under section 192.' },
];

export function buildReturn(type: ReturnKind, rows: ReturnRow[], month: number, year: number): ReturnFile {
  switch (type) {
    case 'pf': return pfRegister(rows, month, year);
    case 'esi': return esiRegister(rows, month, year);
    case 'pt': return ptRegister(rows, month, year);
    case 'tds': return tdsRegister(rows, month, year);
    case 'register':
    default: return payrollRegister(rows, month, year);
  }
}

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}
