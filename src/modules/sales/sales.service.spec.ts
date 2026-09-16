import { SalesService } from './sales.service';

describe('SalesService', () => {
  let stages: any, leads: any, accounts: any, contacts: any, activities: any, followups: any, requirements: any, quotes: any, leadDocuments: any, users: any, clientRecords: any, clientsService: any, notifier: any;
  let service: SalesService;
  const caller = { userId: 'u1', orgId: 'orgA', isAdmin: true };

  beforeEach(() => {
    const repo = () => ({ find: jest.fn(), findOne: jest.fn(), save: jest.fn((v) => Promise.resolve(Array.isArray(v) ? v : { id: 'new1', ...v })), create: jest.fn((v) => v), update: jest.fn(), count: jest.fn().mockResolvedValue(0) });
    stages = repo(); leads = repo(); accounts = repo(); contacts = repo(); activities = repo(); followups = repo(); requirements = repo(); quotes = repo(); leadDocuments = repo(); users = repo(); clientRecords = repo();
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    clientsService = { create: jest.fn().mockResolvedValue({ id: 'client1' }) };
    users.findOne.mockResolvedValue({ firstName: 'A', lastName: 'B' });
    service = new SalesService(stages, leads, accounts, contacts, activities, followups, requirements, quotes, leadDocuments, users, clientRecords, clientsService, notifier);
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

  it('createLead defaults to the isDefault stage and stores the requirement (no activity log)', async () => {
    stages.find.mockResolvedValue(seededStages);
    const lead = await service.createLead(caller, { name: 'Acme', value: 1000, requirement: '<p>Build an app</p>' } as any);
    expect(lead.stageId).toBe('s-new');
    expect(lead.status).toBe('open');
    expect(lead.requirement).toBe('<p>Build an app</p>');
    expect(activities.save).not.toHaveBeenCalled(); // system activity logging removed
  });

  it('moveStage to a won stage marks the lead won and stamps wonAt', async () => {
    leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, stageId: 's-new', status: 'open', wonAt: null });
    stages.findOne.mockResolvedValue(seededStages[2]); // Won
    const out = await service.moveStage(caller, 'l1', { stageId: 's-won' });
    expect(out.status).toBe('won');
    expect(out.stageId).toBe('s-won');
    expect(out.wonAt).toBeTruthy();
  });

  it('moveStage to a lost stage marks the lead lost and clears wonAt', async () => {
    leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, stageId: 's-won', status: 'won', wonAt: new Date() });
    stages.findOne.mockResolvedValue(seededStages[3]); // Lost
    const out = await service.moveStage(caller, 'l1', { stageId: 's-lost' });
    expect(out.status).toBe('lost');
    expect(out.wonAt).toBeNull();
  });

  it('rejects a move to an unknown stage', async () => {
    leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false });
    stages.findOne.mockResolvedValue(null);
    await expect(service.moveStage(caller, 'l1', { stageId: 'nope' })).rejects.toThrow(/Stage not found/);
  });

  it('overview computes weighted forecast + win rate (lead-centric)', async () => {
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
    expect((ov as any).deals).toBeUndefined();
  });

  describe('requirements + rollup', () => {
    it('rolls up requirement effort into the lead value (skips dropped)', async () => {
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false });
      requirements.find.mockResolvedValue([
        { unit: 'hours', quantity: '40', rate: '100', status: 'open' },   // 4000
        { unit: 'days', quantity: '5', rate: '8000', status: 'in_progress' }, // 40000
        { unit: 'hours', quantity: '10', rate: '100', status: 'dropped' }, // skipped
      ]);
      users.find.mockResolvedValue([]);
      const out = await service.rollupLeadValue(caller, 'l1');
      expect(leads.save).toHaveBeenCalledWith(expect.objectContaining({ value: '44000' }));
      expect(out).toBeDefined();
    });

    it('addRequirement stores effort + computes amount in the view', async () => {
      requirements.save.mockImplementation((v: any) => Promise.resolve({ id: 'r1', ...v }));
      const r = await service.addRequirement(caller, 'lead', 'l1', { title: 'Backend API', unit: 'days', quantity: 6, rate: 9000, role: 'Backend dev' } as any);
      expect(r.amount).toBe(54000);
      expect(r.role).toBe('Backend dev');
    });
  });

  describe('lead documents', () => {
    it('attaches an uploaded file to a lead (no activity log)', async () => {
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false });
      leadDocuments.save.mockImplementation((v: any) => Promise.resolve({ id: 'doc1', ...v }));
      const d = await service.addDocument(caller, 'l1', { fileId: 'f1', fileName: 'brief.pdf', mimeType: 'application/pdf', size: 2048, title: 'Brief' } as any);
      expect(d).toMatchObject({ leadId: 'l1', fileId: 'f1', name: 'Brief', size: 2048 });
      expect(activities.save).not.toHaveBeenCalled(); // system activity logging removed
    });
  });

  describe('quotes', () => {
    it('computes subtotal, percentage discount, tax and total on create', async () => {
      quotes.save.mockImplementation((v: any) => Promise.resolve({ id: 'q1', ...v }));
      const q = await service.createQuote(caller, 'lead', 'l1', {
        title: 'Proposal', discountType: 'percent', discountValue: 10, taxPercent: 18,
        items: [{ description: 'Backend', unit: 'days', quantity: 10, rate: 9000 }, { description: 'Frontend', unit: 'hours', quantity: 60, rate: 1200 }],
      } as any);
      expect(q.subtotal).toBe(162000);
      expect(q.discountAmount).toBe(16200);
      expect(q.total).toBe(172044); // 145800 + 18%
      expect(q.number).toBe('Q-0001');
    });

    it('builds a quote from requirements (skips dropped)', async () => {
      requirements.find.mockResolvedValue([
        { title: 'API', role: 'BE', unit: 'days', quantity: '5', rate: '9000', status: 'open' },
        { title: 'Old', unit: 'hours', quantity: '10', rate: '100', status: 'dropped' },
      ]);
      quotes.save.mockImplementation((v: any) => Promise.resolve({ id: 'q1', ...v }));
      const q = await service.quoteFromRequirements(caller, 'lead', 'l1');
      expect(q.items).toHaveLength(1);
      expect(q.items[0].description).toBe('API (BE)');
      expect(q.subtotal).toBe(45000);
    });

    it('setQuoteStatus stamps acceptedAt', async () => {
      quotes.findOne.mockResolvedValue({ id: 'q1', organizationId: 'orgA', isDeleted: false, items: [], discountType: 'percent', discountValue: '0', taxPercent: '0', status: 'draft' });
      const q = await service.setQuoteStatus('orgA', 'q1', 'accepted');
      expect(q.status).toBe('accepted');
      expect(q.acceptedAt).toBeTruthy();
    });
  });

  describe('convertLeadToClient', () => {
    it('creates a client from the won lead and links it', async () => {
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, name: 'Jane', company: 'BigCo', email: 'jane@bigco.com', phone: null, title: 'CTO', value: '150000', currency: 'INR', clientId: null });
      const out = await service.convertLeadToClient(caller, 'l1');
      expect(clientsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'orgA' }),
        expect.objectContaining({ companyName: 'BigCo', primaryContact: expect.objectContaining({ name: 'Jane' }) }),
      );
      expect(out.clientId).toBe('client1');
      expect(leads.save).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client1' }));
    });

    it('refuses if the lead is already linked to a client', async () => {
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, clientId: 'existing' });
      await expect(service.convertLeadToClient(caller, 'l1')).rejects.toThrow(/already linked/);
    });
  });

  describe('analytics + import/export', () => {
    it('builds a lead-centric rep leaderboard, source breakdown, and monthly won revenue', async () => {
      stages.find.mockResolvedValue(seededStages);
      const now = new Date();
      leads.find.mockResolvedValue([
        { assignedTo: 'u1', source: 'referral', stageId: 's-prop', status: 'open', value: '100000', createdAt: now, wonAt: null },
        { assignedTo: 'u1', source: 'referral', stageId: 's-won', status: 'won', value: '50000', createdAt: new Date(now.getTime() - 5 * 86400000), wonAt: now },
        { assignedTo: 'u2', source: 'website', stageId: 's-lost', status: 'lost', value: '30000', createdAt: now, wonAt: null },
      ]);
      users.find.mockResolvedValue([{ id: 'u1', firstName: 'Rae', lastName: 'One' }, { id: 'u2', firstName: 'Sam', lastName: 'Two' }]);

      const a = await service.analytics('orgA');
      expect(a.totals.openValue).toBe(100000);
      expect(a.totals.wonValue).toBe(50000);
      expect(Math.round(a.totals.weightedForecast)).toBe(60000); // 100k @ 60%
      expect(a.leaderboard[0].userId).toBe('u1'); // 50k won → top
      expect(a.leaderboard[0].wonValue).toBe(50000);
      expect(a.leaderboard[0].winRate).toBe(1); // 1 won of 1 closed for u1
      const referral = a.bySource.find((s) => s.source === 'referral');
      expect(referral).toMatchObject({ count: 2, converted: 1 }); // 1 of the 2 is won
      expect(a.monthly).toHaveLength(6);
      expect(a.monthly[5].wonValue).toBe(50000); // current month
      expect(a.totals.avgCycleDays).toBe(5);
    });

    it('exports leads to CSV with a header and escaped cells', async () => {
      stages.find.mockResolvedValue(seededStages);
      leads.find.mockResolvedValue([
        { name: 'Acme, Inc', company: 'Acme', email: 'a@x.com', phone: null, title: null, source: 'referral', stageId: 's-new', status: 'open', value: '1000', currency: 'INR', tags: ['vip'], createdAt: new Date('2026-01-02') },
      ]);
      const csv = await service.exportLeadsCsv('orgA');
      const [header, row] = csv.split('\n');
      expect(header).toContain('Name');
      expect(row).toContain('"Acme, Inc"'); // comma-bearing cell quoted
      expect(row).toContain('New'); // stage name resolved
    });

    it('imports leads in bulk, skipping rows without a name', async () => {
      stages.find.mockResolvedValue(seededStages);
      const out = await service.importLeads(caller, [
        { name: 'Lead One', company: 'Co', email: 'ONE@X.com', value: '5000', tags: 'a; b' },
        { name: '', company: 'No name' },
        { company: 'Also no name' },
      ] as any);
      expect(out).toEqual({ created: 1, skipped: 2 });
      expect(leads.save).toHaveBeenCalledTimes(1);
      const saved = leads.save.mock.calls[0][0];
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ name: 'Lead One', email: 'one@x.com', source: 'import', stageId: 's-new', tags: ['a', 'b'] });
    });
  });

  describe('lead source = client', () => {
    beforeEach(() => stages.find.mockResolvedValue(seededStages));

    it('requires a client when the source is client', async () => {
      await expect(service.createLead(caller, { name: 'Ref lead', source: 'client' } as any)).rejects.toThrow(/Choose the client/);
      expect(leads.save).not.toHaveBeenCalled();
    });

    it('rejects a client that is not in the caller org', async () => {
      clientRecords.findOne.mockResolvedValue(null);
      await expect(service.createLead(caller, { name: 'Ref lead', source: 'client', sourceClientId: 'c-other' } as any)).rejects.toThrow(/Client not found/);
      expect(clientRecords.findOne).toHaveBeenCalledWith({ where: { id: 'c-other', organizationId: 'orgA', isDeleted: false } });
    });

    it('stores the source client and ignores sourceClientId for other sources', async () => {
      clientRecords.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA' });
      const fromClient = await service.createLead(caller, { name: 'Ref lead', source: 'client', sourceClientId: 'c1', sourceDetail: 'x' } as any);
      expect(fromClient.sourceClientId).toBe('c1');
      expect(fromClient.sourceDetail).toBeNull();
      const fromWeb = await service.createLead(caller, { name: 'Web lead', source: 'website', sourceClientId: 'c1' } as any);
      expect(fromWeb.sourceClientId).toBeNull();
    });

    it('fills the contact from the client when none is given', async () => {
      clientRecords.findOne.mockResolvedValue({
        id: 'c1', organizationId: 'orgA', companyName: 'Acme Private Limited', displayName: 'Acme',
        primaryContact: { name: 'Riya Shah', email: 'Riya@Acme.com', phone: '+91 98', designation: 'CTO' },
      });
      const lead = await service.createLead(caller, { source: 'client', sourceClientId: 'c1' } as any);
      expect(lead).toMatchObject({ name: 'Riya Shah', company: 'Acme', email: 'riya@acme.com', phone: '+91 98', title: 'CTO', sourceClientId: 'c1' });
    });

    it('names a client-sourced lead after the client when it has no primary contact', async () => {
      clientRecords.findOne.mockResolvedValue({ id: 'c2', organizationId: 'orgA', companyName: 'Globex', displayName: null, primaryContact: null });
      const lead = await service.createLead(caller, { source: 'client', sourceClientId: 'c2' } as any);
      expect(lead).toMatchObject({ name: 'Globex', company: 'Globex', email: null, phone: null });
    });

    it('still requires a contact name for non-client sources', async () => {
      await expect(service.createLead(caller, { source: 'website' } as any)).rejects.toThrow(/Contact name is required/);
    });

    it('switching a client-sourced lead to another source clears the client', async () => {
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, source: 'client', sourceClientId: 'c1', stageId: 's-new' });
      users.find.mockResolvedValue([]);
      const out = await service.updateLead(caller, 'l1', { source: 'referral' } as any);
      expect(out.source).toBe('referral');
      expect(out.sourceClientId).toBeNull();
    });

    it('lists leads with the source client name', async () => {
      leads.find.mockResolvedValue([{ id: 'l1', organizationId: 'orgA', source: 'client', sourceClientId: 'c1', assignedTo: null, value: null }]);
      clientRecords.find.mockResolvedValue([{ id: 'c1', companyName: 'Acme Pvt Ltd', displayName: 'Acme' }]);
      const { leads: rows } = await service.board('orgA', true);
      expect(rows[0].sourceClientName).toBe('Acme');
    });
  });

  describe('source details (sourceMeta)', () => {
    beforeEach(() => stages.find.mockResolvedValue(seededStages));

    it('keeps only the fields that belong to the chosen source, trimmed', async () => {
      const lead = await service.createLead(caller, {
        name: 'Summit lead', source: 'event',
        sourceMeta: { eventName: '  Nasscom Summit ', eventDate: '2026-09-10', eventLocation: '', referrerName: 'nope', hack: 'x' },
      } as any);
      expect(lead.sourceMeta).toEqual({ eventName: 'Nasscom Summit', eventDate: '2026-09-10' });
    });

    it('stores nothing for sources without detail fields', async () => {
      const lead = await service.createLead(caller, { name: 'Misc', source: 'other', sourceDetail: 'Trade body', sourceMeta: { eventName: 'x' } } as any);
      expect(lead.sourceMeta).toBeNull();
      expect(lead.sourceDetail).toBe('Trade body');
    });

    it('changing the source drops the old details unless new ones are sent', async () => {
      users.find.mockResolvedValue([]);
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, source: 'event', sourceMeta: { eventName: 'Summit' }, stageId: 's-new' });
      const cleared = await service.updateLead(caller, 'l1', { source: 'referral' } as any);
      expect(cleared.sourceMeta).toBeNull();

      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, source: 'event', sourceMeta: { eventName: 'Summit' }, stageId: 's-new' });
      const moved = await service.updateLead(caller, 'l1', { source: 'referral', sourceMeta: { referrerName: 'Rahul' } } as any);
      expect(moved.sourceMeta).toEqual({ referrerName: 'Rahul' });
    });

    it('updating details alone keeps the source and sanitizes against it', async () => {
      users.find.mockResolvedValue([]);
      leads.findOne.mockResolvedValue({ id: 'l1', organizationId: 'orgA', isDeleted: false, source: 'social', sourceMeta: { platform: 'LinkedIn' }, stageId: 's-new' });
      const out = await service.updateLead(caller, 'l1', { sourceMeta: { platform: 'Instagram', profileUrl: 'https://instagram.com/acme', eventName: 'x' } } as any);
      expect(out.source).toBe('social');
      expect(out.sourceMeta).toEqual({ platform: 'Instagram', profileUrl: 'https://instagram.com/acme' });
    });
  });

  describe('follow-ups', () => {
    it('records what we are waiting on and sets the lead next follow-up to the soonest open one', async () => {
      followups.findOne.mockResolvedValue({ dueAt: new Date('2026-09-20T00:00:00Z') }); // soonest open
      const f = await service.addFollowup(caller, 'lead', 'l1', { dueAt: '2026-09-30T00:00:00Z', note: '  Sent proposal v2  ', waitingOn: 'client' } as any);
      expect(f.note).toBe('Sent proposal v2');
      expect(f.waitingOn).toBe('client');
      expect(leads.update).toHaveBeenCalledWith({ id: 'l1', organizationId: 'orgA' }, { nextFollowUpAt: new Date('2026-09-20T00:00:00Z') });
    });

    it('completing the last open follow-up clears the lead next follow-up', async () => {
      followups.findOne
        .mockResolvedValueOnce({ id: 'f1', organizationId: 'orgA', entityType: 'lead', entityId: 'l1', status: 'pending', isDeleted: false })
        .mockResolvedValueOnce(null); // no open follow-ups left
      const out = await service.updateFollowup('orgA', 'f1', { status: 'done' } as any);
      expect(out.status).toBe('done');
      expect(out.completedAt).toBeTruthy();
      expect(leads.update).toHaveBeenCalledWith({ id: 'l1', organizationId: 'orgA' }, { nextFollowUpAt: null });
    });
  });
});
