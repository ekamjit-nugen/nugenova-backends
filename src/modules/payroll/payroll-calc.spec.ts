import { resolveLop, computeSimplePayslip, rupeesInWords } from './payroll-calc';

describe('resolveLop', () => {
  it('full attendance → no LOP', () => {
    const r = resolveLop({ workingDays: 22, presentDays: 22, halfDays: 0, paidLeaveDays: 0, lopLeaveDays: 0 });
    expect(r.absentDays).toBe(0);
    expect(r.lopDays).toBe(0);
  });

  it('unaccounted working days count as absent LOP', () => {
    const r = resolveLop({ workingDays: 22, presentDays: 20, halfDays: 0, paidLeaveDays: 0, lopLeaveDays: 0 });
    expect(r.absentDays).toBe(2);
    expect(r.lopDays).toBe(2);
  });

  it('paid leave does not dock; lop-type leave does', () => {
    const r = resolveLop({ workingDays: 22, presentDays: 18, halfDays: 0, paidLeaveDays: 2, lopLeaveDays: 2 });
    expect(r.absentDays).toBe(0); // 18 + 2 + 2 = 22, all accounted
    expect(r.lopDays).toBe(2); // only the lop-type leave
  });

  it('half-days contribute half a LOP day each', () => {
    const r = resolveLop({ workingDays: 22, presentDays: 20, halfDays: 2, paidLeaveDays: 0, lopLeaveDays: 0 });
    // accounted 20 + 2 = 22 → absent 0; lop = 0 + 0 + 0.5*2 = 1
    expect(r.absentDays).toBe(0);
    expect(r.lopDays).toBe(1);
  });

  it('caps LOP at working days', () => {
    const r = resolveLop({ workingDays: 22, presentDays: 0, halfDays: 0, paidLeaveDays: 0, lopLeaveDays: 30 });
    expect(r.lopDays).toBe(22);
  });
});

describe('computeSimplePayslip', () => {
  it('no LOP → net equals salary', () => {
    const lop = resolveLop({ workingDays: 22, presentDays: 22, halfDays: 0, paidLeaveDays: 0, lopLeaveDays: 0 });
    const p = computeSimplePayslip(44000, lop);
    expect(p.perDayPay).toBe(2000);
    expect(p.lopDeduction).toBe(0);
    expect(p.netPay).toBe(44000);
    expect(p.payableDays).toBe(22);
  });

  it('deducts per-day pay for LOP days', () => {
    const lop = resolveLop({ workingDays: 22, presentDays: 20, halfDays: 0, paidLeaveDays: 0, lopLeaveDays: 0 });
    const p = computeSimplePayslip(44000, lop); // 2 LOP × 2000 = 4000
    expect(p.lopDeduction).toBe(4000);
    expect(p.netPay).toBe(40000);
    expect(p.payableDays).toBe(20);
  });

  it('never goes negative', () => {
    const lop = resolveLop({ workingDays: 22, presentDays: 0, halfDays: 0, paidLeaveDays: 0, lopLeaveDays: 22 });
    const p = computeSimplePayslip(44000, lop);
    expect(p.netPay).toBe(0);
    expect(p.lopDeduction).toBe(44000);
  });

  it('pays nothing when there are no payable working days (salary not yet effective)', () => {
    const lop = resolveLop({ workingDays: 0, presentDays: 0, halfDays: 0, paidLeaveDays: 0, lopLeaveDays: 0 });
    const p = computeSimplePayslip(44000, lop);
    expect(p.perDayPay).toBe(0);
    expect(p.grossEarnings).toBe(0);
    expect(p.netPay).toBe(0);
  });
});

describe('rupeesInWords', () => {
  it('formats Indian units', () => {
    expect(rupeesInWords(0)).toBe('Zero Rupees');
    expect(rupeesInWords(44000)).toBe('Forty Four Thousand Rupees');
    expect(rupeesInWords(125000)).toBe('One Lakh Twenty Five Thousand Rupees');
    expect(rupeesInWords(4000)).toBe('Four Thousand Rupees');
    expect(rupeesInWords(101)).toBe('One Hundred One Rupees');
  });
});
