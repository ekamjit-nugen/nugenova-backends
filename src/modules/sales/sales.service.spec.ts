import { SalesService } from './sales.service';

describe('SalesService', () => {
  let stages: any, leads: any, accounts: any, contacts: any, activities: any, followups: any, users: any, notifier: any;
  let service: SalesService;
  const caller = { userId: 'u1', orgId: 'orgA', isAdmin: true };

  beforeEach(() => {
    const repo = () => ({ find: jest.fn(), findOne: jest.fn(), save: jest.fn((v) => Promise.resolve(Array.isArray(v) ? v : { id: 'new1', ...v })), create: jest.fn((v) => v), update: jest.fn() });
    stages = repo(); leads = repo(); accounts = repo(); contacts = repo(); activities = repo(); followups = repo(); users = repo();
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    users.findOne.mockResolvedValue({ firstName: 'A', lastName: 'B' });
    service = new SalesService(stages, leads, accounts, contacts, activities, followups, users, notifier);
  });

  const seededStages = [
    { id: 's-new', name: 'New', isDefault: true, isWon: false, isLost: false, probability: 10, order: 1 },
    { id: 's-prop', name: 'Proposal', isDefault: false, isWon: false, isLost: false, probability: 60, order: 4 },
    { id: 's-won', name: 'Won', isWon: true, isLost: false, probability: 100, order: 6 },
    { id: 's-lost', name: 'Lost', isWon: false, isLost: true, probability: 0, order: 7 },
  ];

  it('ensureStages seeds the default funnel when none exist', async () => {
    stages.find.mockResolvedValueOnce([]).mockResolvedValueOnce(seededStages);
    const out = await service.ensureStages('orgA');
    expect(stages.save).toHaveBeenCalled();
    expect(out).toHaveLength(4);
  });

  it('createLead defaults to the isDefault stage and logs a system activity', async () => {
    stages.find.mockResolvedValue(seededStages);
    const lead = await service.createLead(caller, { name: 'Acme', value: 1000 } as any);
    expect(lead.stageId).toBe('s-new');
    expect(lead.status).toBe('open');
    expect(activities.save).toHaveBeenCalled(); // "Lead created"
  });

  it('moveStage to a won stage marks the lead won', async () => {
    leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, stageId: 's-new', status: 'open' });
    stages.findOne.mockResolvedValue(seededStages[2]); // Won
    const out = await service.moveStage(caller, 'l1', { stageId: 's-won' });
    expect(out.status).toBe('won');
    expect(out.stageId).toBe('s-won');
  });

  it('moveStage to a lost stage marks the lead lost', async () => {
    leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, stageId: 's-new', status: 'open' });
    stages.findOne.mockResolvedValue(seededStages[3]); // Lost
    const out = await service.moveStage(caller, 'l1', { stageId: 's-lost' });
    expect(out.status).toBe('lost');
  });

  it('overview computes weighted forecast + win rate', async () => {
    stages.find.mockResolvedValue(seededStages);
    leads.find.mockResolvedValue([
      { stageId: 's-prop', status: 'open', value: '100000' }, // 60% → 60000
      { stageId: 's-won', status: 'won', value: '50000' },
      { stageId: 's-lost', status: 'lost', value: '20000' },
    ]);
    const ov = await service.overview('orgA');
    expect(ov.openValue).toBe(100000);
    expect(Math.round(ov.weightedForecast)).toBe(60000);
    expect(ov.wonValue).toBe(50000);
    expect(ov.winRate).toBe(0.5); // 1 won of 2 closed
  });

  it('rejects a move to an unknown stage', async () => {
    leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false });
    stages.findOne.mockResolvedValue(null);
    await expect(service.moveStage(caller, 'l1', { stageId: 'nope' })).rejects.toThrow(/Stage not found/);
  });
});
