import {
  defaultLeaveConfig,
  resolveLeaveConfig,
  sanitizeLeaveConfig,
  LEAVE_TYPE_KEYS,
} from './leave-config';

describe('leave-config defaults', () => {
  it('enables all 9 standard types at their default allocation', () => {
    const cfg = defaultLeaveConfig();
    expect(cfg.leaveTypes).toHaveLength(9);
    const casual = cfg.leaveTypes.find((t) => t.key === 'casual')!;
    expect(casual.annualAllocation).toBe(12);
    expect(casual.enabled).toBe(true);
    expect(casual.custom).toBe(false);
    expect(cfg.leaveTypes.find((t) => t.key === 'lop')!.balanceTracked).toBe(false);
  });
});

describe('resolveLeaveConfig', () => {
  it('applies saved overrides to standard types, defaults elsewhere', () => {
    const cfg = resolveLeaveConfig([{ key: 'casual', annualAllocation: 18, enabled: true }]);
    expect(cfg.leaveTypes.find((t) => t.key === 'casual')!.annualAllocation).toBe(18);
    expect(cfg.leaveTypes.find((t) => t.key === 'sick')!.annualAllocation).toBe(12);
  });

  it('appends custom types after the standard ones', () => {
    const cfg = resolveLeaveConfig([
      { key: 'study', label: 'Study Leave', annualAllocation: 10, enabled: true },
    ]);
    expect(cfg.leaveTypes).toHaveLength(10);
    const study = cfg.leaveTypes.find((t) => t.key === 'study')!;
    expect(study.label).toBe('Study Leave');
    expect(study.annualAllocation).toBe(10);
    expect(study.balanceTracked).toBe(true);
    expect(study.isLop).toBe(false);
    expect(study.custom).toBe(true);
    // standards still first
    expect(LEAVE_TYPE_KEYS.includes(cfg.leaveTypes[0].key as any)).toBe(true);
  });
});

describe('sanitizeLeaveConfig', () => {
  it('stores standard types without a label and customs with one', () => {
    const out = sanitizeLeaveConfig([
      { key: 'casual', label: 'ignored', annualAllocation: 20, enabled: true },
      { key: 'study', label: 'Study Leave', annualAllocation: 8, enabled: true },
    ]);
    const casual = out.find((t) => t.key === 'casual')!;
    expect(casual.label).toBeUndefined();
    expect(casual.annualAllocation).toBe(20);
    const study = out.find((t) => t.key === 'study')!;
    expect(study.label).toBe('Study Leave');
  });

  it('drops custom types with no label or an unsafe key', () => {
    const out = sanitizeLeaveConfig([
      { key: 'nolabel', annualAllocation: 5, enabled: true },
      { key: 'Bad Key!', label: 'Bad', annualAllocation: 5, enabled: true },
      { key: 'ok_type', label: 'Fine', annualAllocation: 5, enabled: true },
    ]);
    expect(out.map((t) => t.key)).toEqual(['ok_type']);
  });

  it('dedupes by key', () => {
    const out = sanitizeLeaveConfig([
      { key: 'casual', annualAllocation: 10, enabled: true },
      { key: 'casual', annualAllocation: 99, enabled: false },
    ]);
    expect(out.filter((t) => t.key === 'casual')).toHaveLength(1);
    expect(out[0].annualAllocation).toBe(10);
  });
});
