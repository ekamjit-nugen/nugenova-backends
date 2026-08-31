import {
  ONBOARDING_CHECKLIST_CATALOG,
  DEFAULT_ONBOARDING_CHECKLIST,
  sanitizeChecklist,
} from './onboarding-catalog';

describe('onboarding checklist catalog', () => {
  it('exposes the standard tasks with stable keys and completion hints', () => {
    const keys = ONBOARDING_CHECKLIST_CATALOG.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'welcome_read',
        'profile_complete',
        'policies_ack',
        'it_accounts',
        'workstation',
        'intro_meeting',
      ]),
    );
    for (const item of ONBOARDING_CHECKLIST_CATALOG) {
      expect(item.completedBy).toBeTruthy();
      expect(typeof item.defaultOn).toBe('boolean');
    }
  });

  it('derives the default checklist from the default-on catalog items', () => {
    const defaultKeys = DEFAULT_ONBOARDING_CHECKLIST.map((c) => c.key).sort();
    const onKeys = ONBOARDING_CHECKLIST_CATALOG.filter((c) => c.defaultOn)
      .map((c) => c.key)
      .sort();
    expect(defaultKeys).toEqual(onKeys);
  });
});

describe('sanitizeChecklist', () => {
  it('forces standard tasks to their canonical fields (ignores tampering)', () => {
    const out = sanitizeChecklist([
      // Attempt to change an IT task into a self-serviceable one:
      { key: 'it_accounts', title: 'Hacked', category: 'welcome', assignedTo: 'self' },
    ]);
    expect(out).toEqual([
      { key: 'it_accounts', title: 'Provision IT accounts & email', category: 'it_setup', assignedTo: 'it' },
    ]);
  });

  it('keeps custom tasks with validated, defaulted fields', () => {
    const out = sanitizeChecklist([
      { key: 'order_swag', title: 'Order swag', category: 'nonsense' as any, assignedTo: 'alien' as any },
    ]);
    expect(out).toEqual([
      { key: 'order_swag', title: 'Order swag', category: 'other', assignedTo: 'self' },
    ]);
  });

  it('drops keyless entries and dedupes by key, preserving order', () => {
    const out = sanitizeChecklist([
      { key: '', title: 'no key' },
      { key: 'welcome_read' },
      { key: 'welcome_read' }, // dupe
      { key: 'order_swag', title: 'Order swag' },
    ]);
    expect(out.map((c) => c.key)).toEqual(['welcome_read', 'order_swag']);
  });

  it('lets an org exclude a standard task by omitting it', () => {
    const selection = DEFAULT_ONBOARDING_CHECKLIST.filter((c) => c.key !== 'intro_meeting');
    const out = sanitizeChecklist(selection);
    expect(out.map((c) => c.key)).not.toContain('intro_meeting');
    expect(out.map((c) => c.key)).toContain('welcome_read');
  });
});
