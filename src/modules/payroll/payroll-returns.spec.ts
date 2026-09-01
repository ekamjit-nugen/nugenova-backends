import {
  buildReturn,
  payrollRegister,
  pfRegister,
  esiRegister,
  ptRegister,
  tdsRegister,
  ReturnRow,
} from './payroll-returns';

function row(over: Partial<ReturnRow> = {}): ReturnRow {
  return {
    name: 'Alice Ray',
    email: 'alice@acme.test',
    workingDays: 22,
    payableDays: 22,
    lopDays: 0,
    grossEarnings: 50000,
    basic: 25000,
    lopDeduction: 0,
    pfWage: 15000,
    pfEmployee: 1800,
    pfEmployer: 1800,
    pfEps: 1250,
    pfEpfEmployer: 550,
    esiEmployee: 0,
    esiEmployer: 0,
    professionalTax: 200,
    lwfEmployee: 0,
    tds: 3000,
    otherDeductions: 0,
    totalDeductions: 5000,
    netPay: 45000,
    ...over,
  };
}

// Parse a CSV back into cell rows (test data has no embedded quotes/commas).
function parse(content: string): string[][] {
  return content.split('\r\n').map((line) => line.split(','));
}

describe('payrollRegister', () => {
  it('emits a header, a row per employee, and a totals row', () => {
    const f = payrollRegister([row(), row({ name: 'Bob', grossEarnings: 30000, netPay: 28000, totalDeductions: 2000, tds: 0 })], 9, 2026);
    const rows = parse(f.content);
    expect(rows[0][0]).toBe('Employee');
    expect(rows).toHaveLength(4); // header + 2 employees + total
    expect(rows[3][0]).toBe('TOTAL');
    expect(f.filename).toBe('payroll-register-2026-09.csv');
    expect(f.rowCount).toBe(2);
  });
  it('totals the money columns', () => {
    const f = payrollRegister([row({ netPay: 45000 }), row({ netPay: 28000 })], 9, 2026);
    const rows = parse(f.content);
    const netCol = rows[0].indexOf('Net pay');
    expect(rows[3][netCol]).toBe('73000');
  });
});

describe('pfRegister (ECR shape)', () => {
  it('lists only PF-covered members and splits EPS/EPF', () => {
    const f = pfRegister([row(), row({ name: 'Uncovered', pfWage: 0, pfEmployee: 0, pfEmployer: 0, pfEps: 0, pfEpfEmployer: 0 })], 9, 2026);
    const rows = parse(f.content);
    expect(f.rowCount).toBe(1); // the uncovered member is excluded
    const epsCol = rows[0].indexOf('EPS contribution (ER)');
    const epfErCol = rows[0].indexOf('EPF contribution (ER)');
    expect(rows[1][epsCol]).toBe('1250');
    expect(rows[1][epfErCol]).toBe('550');
  });
  it('caps EPS wage at ₹15,000', () => {
    const f = pfRegister([row({ pfWage: 15000 })], 9, 2026);
    const rows = parse(f.content);
    const epsWageCol = rows[0].indexOf('EPS wages');
    expect(rows[1][epsWageCol]).toBe('15000');
  });
});

describe('esiRegister', () => {
  it('excludes members with no ESI', () => {
    const f = esiRegister([row(), row({ name: 'Cov', esiEmployee: 150, esiEmployer: 650 })], 9, 2026);
    expect(f.rowCount).toBe(1);
    expect(f.content).toContain('Cov');
    expect(f.content).not.toContain('Alice Ray');
  });
});

describe('ptRegister', () => {
  it('lists members with professional tax', () => {
    const f = ptRegister([row(), row({ name: 'NoPt', professionalTax: 0 })], 9, 2026);
    expect(f.rowCount).toBe(1);
    const rows = parse(f.content);
    expect(rows[1][rows[0].indexOf('Professional tax')]).toBe('200');
  });
});

describe('tdsRegister (24Q Annexure I)', () => {
  it('lists deductees with TDS under section 192', () => {
    const f = tdsRegister([row(), row({ name: 'NoTds', tds: 0 })], 9, 2026);
    expect(f.rowCount).toBe(1);
    const rows = parse(f.content);
    expect(rows[1][rows[0].indexOf('Section')]).toBe('192');
    expect(rows[1][rows[0].indexOf('TDS deducted')]).toBe('3000');
  });
});

describe('buildReturn dispatcher', () => {
  it('routes each type to its generator', () => {
    const rows = [row()];
    expect(buildReturn('register', rows, 9, 2026).filename).toContain('payroll-register');
    expect(buildReturn('pf', rows, 9, 2026).filename).toContain('pf-ecr');
    expect(buildReturn('esi', rows, 9, 2026).filename).toContain('esi-register');
    expect(buildReturn('pt', rows, 9, 2026).filename).toContain('pt-register');
    expect(buildReturn('tds', rows, 9, 2026).filename).toContain('tds-24q');
  });
});
