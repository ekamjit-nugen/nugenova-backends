import { buildPayoutFile, isPayable, PayoutBeneficiary } from './bank-payout';

function ben(over: Partial<PayoutBeneficiary> = {}): PayoutBeneficiary {
  return {
    name: 'Alice Ray',
    accountHolder: 'Alice Ray',
    accountNumber: '123456789012',
    ifsc: 'HDFC0001234',
    bankName: 'HDFC Bank',
    netPay: 48000,
    ...over,
  };
}
const parse = (c: string) => c.split('\r\n').map((l) => l.split(','));

describe('isPayable', () => {
  it('needs an account number, IFSC and a positive net', () => {
    expect(isPayable(ben())).toBe(true);
    expect(isPayable(ben({ accountNumber: null }))).toBe(false);
    expect(isPayable(ben({ ifsc: null }))).toBe(false);
    expect(isPayable(ben({ netPay: 0 }))).toBe(false);
  });
});

describe('buildPayoutFile', () => {
  it('emits a header, a row per payable beneficiary, and a totals row', () => {
    const f = buildPayoutFile([ben(), ben({ name: 'Bob', netPay: 30000 })], 9, 2026);
    const rows = parse(f.content);
    expect(rows[0][0]).toBe('Beneficiary Name');
    expect(rows).toHaveLength(4); // header + 2 + total
    expect(rows[3][0]).toBe('TOTAL');
    expect(f.count).toBe(2);
    expect(f.totalAmount).toBe(78000);
    expect(f.filename).toBe('salary-payout-2026-09.csv');
  });

  it('carries account/IFSC/amount and the NEFT type + reference', () => {
    const f = buildPayoutFile([ben()], 9, 2026);
    const rows = parse(f.content);
    expect(rows[1][1]).toBe('123456789012');
    expect(rows[1][2]).toBe('HDFC0001234');
    expect(rows[1][3]).toBe('48000');
    expect(rows[1][4]).toBe('NEFT');
    expect(rows[1][5]).toBe('Salary Sep-2026');
  });

  it('skips beneficiaries with missing bank details and reports them', () => {
    const f = buildPayoutFile([ben(), ben({ name: 'No Bank', accountNumber: null })], 9, 2026);
    expect(f.count).toBe(1);
    expect(f.skipped).toEqual(['No Bank']);
    expect(f.content).not.toContain('No Bank');
  });
});
