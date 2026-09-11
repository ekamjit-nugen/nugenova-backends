import { SalesService } from './sales.service';

describe('SalesService', () => {
  let stages: any, leads: any, accounts: any, contacts: any, activities: any, followups: any, deals: any, requirements: any, users: any, notifier: any;
  let service: SalesService;
  const caller = { userId: 'u1', orgId: 'orgA', isAdmin: true };

  beforeEach(() => {
    const repo = () => ({ find: jest.fn(), findOne: jest.fn(), save: jest.fn((v) => Promise.resolve(Array.isArray(v) ? v : { id: 'new1', ...v })), create: jest.fn((v) => v), update: jest.fn() });
    stages = repo(); leads = repo(); accounts = repo(); contacts = repo(); activities = repo(); followups = repo(); deals = repo(); requirements = repo(); users = repo();
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    users.findOne.mockResolvedValue({ firstName: 'A', lastName: 'B' });
    service = new SalesService(stages, leads, accounts, contacts, activities, followups, deals, requirements, users, notifier);
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
    deals.find.mockResolvedValue([]);
    const ov = await service.overview('orgA');
    expect(ov.openValue).toBe(100000);
    expect(Math.round(ov.weightedForecast)).toBe(60000);
    expect(ov.wonValue).toBe(50000);
    expect(ov.winRate).toBe(0.5); // 1 won of 2 closed
  });

  describe('deals + requirements', () => {
    it('converts a lead to a deal, links source, and moves requirements over', async () => {
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, name: 'Acme', company: 'Acme Co', value: '90000', currency: 'INR', stageId: 's-prop', tags: [], convertedToDealId: null });
      deals.save.mockResolvedValue({ id: 'd1', organizationId: 'orgA', stageId: 's-prop', status: 'open', amount: '90000', assignedTo: null });
      // getDeal (called at the end)
      deals.findOne.mockResolvedValue({ id: 'd1', organizationId: 'orgA', isDeleted: false, stageId: 's-prop', status: 'open', amount: '90000', assignedTo: null });
      stages.findOne.mockResolvedValue(seededStages[1]);
      activities.find.mockResolvedValue([]); followups.find.mockResolvedValue([]); requirements.find.mockResolvedValue([]);
      const out = await service.convertLead(caller, 'l1', { createAccount: true } as any);
      expect(deals.save).toHaveBeenCalled();
      expect(requirements.update).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'lead', entityId: 'l1' }),
        expect.objectContaining({ entityType: 'deal', entityId: 'd1' }),
      );
      expect(leads.save).toHaveBeenCalledWith(expect.objectContaining({ convertedToDealId: 'd1' }));
      expect(out.deal).toBeDefined();
    });

    it('refuses to convert an already-converted lead', async () => {
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, convertedToDealId: 'd0' });
      await expect(service.convertLead(caller, 'l1', {} as any)).rejects.toThrow(/already been converted/);
    });

    it('rolls up requirement effort into a deal amount (skips dropped)', async () => {
      deals.findOne.mockResolvedValue({ id: 'd1', organizationId: 'orgA', isDeleted: false });
      requirements.find.mockResolvedValue([
        { unit: 'hours', quantity: '40', rate: '100', status: 'open' },   // 4000
        { unit: 'days', quantity: '5', rate: '8000', status: 'in_progress' }, // 40000
        { unit: 'hours', quantity: '10', rate: '100', status: 'dropped' }, // skipped
      ]);
      const out = await service.rollupDealAmount(caller, 'd1');
      expect(deals.save).toHaveBeenCalledWith(expect.objectContaining({ amount: '44000' }));
      expect(out).toBeDefined();
    });

    it('addRequirement stores effort + computes amount in the view', async () => {
      requirements.save.mockImplementation((v: any) => Promise.resolve({ id: 'r1', ...v }));
      const r = await service.addRequirement(caller, 'deal', 'd1', { title: 'Backend API', unit: 'days', quantity: 6, rate: 9000, role: 'Backend dev' } as any);
      expect(r.amount).toBe(54000);
      expect(r.role).toBe('Backend dev');
    });
  });

  it('rejects a move to an unknown stage', async () => {
    leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false });
    stages.findOne.mockResolvedValue(null);
    await expect(service.moveStage(caller, 'l1', { stageId: 'nope' })).rejects.toThrow(/Stage not found/);
  });
});
