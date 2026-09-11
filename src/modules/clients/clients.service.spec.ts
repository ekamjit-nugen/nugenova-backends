import { ClientsService } from './clients.service';

/**
 * Pure unit tests for ClientsService — repos are mocked, so these lock the
 * branching/validation logic (dedup, role guards, permission gates, cascades)
 * without a database. End-to-end behaviour is covered by clients.e2e-spec.ts.
 */
describe('ClientsService', () => {
  let clients: any, contacts: any, assignments: any, shares: any, agreements: any, agreementTemplates: any, documents: any, memberships: any, users: any, boards: any, notes: any, nodes: any, comments: any, mail: any, notifier: any;
  let service: ClientsService;

  const admin = { userId: 'owner1', orgId: 'orgA', isAdmin: true };

  beforeEach(() => {
    const repo = () => ({ find: jest.fn(), findOne: jest.fn(), save: jest.fn((v) => Promise.resolve({ id: 'new1', ...v })), create: jest.fn((v) => ({ ...v })), update: jest.fn(), delete: jest.fn(), count: jest.fn() });
    clients = repo(); contacts = repo(); assignments = repo(); shares = repo(); agreements = repo(); agreementTemplates = repo(); documents = repo(); memberships = repo(); users = repo(); boards = repo(); notes = repo(); nodes = repo(); comments = repo();
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    service = new ClientsService(clients, contacts, assignments, shares, agreements, agreementTemplates, documents, memberships, users, boards, notes, nodes, comments, mail, notifier);
  });

  describe('create', () => {
    it('creates a client when the name is unique', async () => {
      clients.findOne.mockResolvedValue(null);
      const out = await service.create(admin, { companyName: '  Acme Corp  ' } as any);
      expect(clients.save).toHaveBeenCalled();
      expect(out.companyName).toBe('Acme Corp'); // trimmed
      expect(out.status).toBe('active');
      expect(out.organizationId).toBe('orgA');
    });

    it('rejects a duplicate company name with a conflict', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1' });
      await expect(service.create(admin, { companyName: 'Acme Corp' } as any)).rejects.toThrow(/already exists/);
      expect(clients.save).not.toHaveBeenCalled();
    });
  });

  describe('shareBoard access gate', () => {
    it('admin can share any org board', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      boards.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', createdBy: 'someone', participants: [] });
      shares.findOne.mockResolvedValue(null);
      const out = await service.shareBoard(admin, 'c1', { boardId: 'b1', permission: 'view' } as any);
      expect(out.boardId).toBe('b1');
      expect(shares.save).toHaveBeenCalled();
    });

    it('a non-admin who is neither creator nor participant cannot share', async () => {
      const staff = { userId: 'emp1', orgId: 'orgA', isAdmin: false };
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      boards.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', createdBy: 'other', participants: [{ userId: 'other' }] });
      await expect(service.shareBoard(staff, 'c1', { boardId: 'b1' } as any)).rejects.toThrow(/only share boards you have access to/);
    });

    it('updates the permission when the board is already shared', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      boards.findOne.mockResolvedValue({ id: 'b1', organizationId: 'orgA', createdBy: 'owner1', participants: [] });
      shares.findOne.mockResolvedValue({ id: 's1', boardId: 'b1', clientId: 'c1', permission: 'view' });
      const out = await service.shareBoard(admin, 'c1', { boardId: 'b1', permission: 'comment' } as any);
      expect(out.permission).toBe('comment');
    });
  });

  describe('assignEmployee', () => {
    it('refuses to assign a client-role user', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      memberships.findOne.mockResolvedValue({ userId: 'p1', role: 'client' });
      await expect(service.assignEmployee(admin, 'c1', { userId: 'p1' } as any)).rejects.toThrow(/active staff member/);
    });

    it('refuses to assign a non-member', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      memberships.findOne.mockResolvedValue(null);
      await expect(service.assignEmployee(admin, 'c1', { userId: 'ghost' } as any)).rejects.toThrow(/active staff member/);
    });

    it('is idempotent — re-assigning updates the role instead of duplicating', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      memberships.findOne.mockResolvedValue({ userId: 'emp1', role: 'employee' });
      assignments.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', userId: 'emp1', assignmentRole: 'Dev' });
      const out = await service.assignEmployee(admin, 'c1', { userId: 'emp1', assignmentRole: 'Lead' } as any);
      expect(out.assignmentRole).toBe('Lead');
      expect(assignments.create).not.toHaveBeenCalled();
    });
  });

  describe('inviteContact', () => {
    it('requires the contact to have an email', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false, companyName: 'Acme' });
      contacts.findOne.mockResolvedValue({ id: 'ct1', clientId: 'c1', email: null, name: 'Jane' });
      await expect(service.inviteContact(admin, 'c1', 'ct1', {} as any)).rejects.toThrow(/email/);
    });

    it('refuses to promote someone who is already a staff member', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false, companyName: 'Acme' });
      contacts.findOne.mockResolvedValue({ id: 'ct1', clientId: 'c1', email: 'jane@acme.com', name: 'Jane Doe' });
      users.findOne.mockResolvedValue({ id: 'u1', email: 'jane@acme.com', organizations: [] });
      memberships.findOne.mockResolvedValue({ userId: 'u1', role: 'employee' });
      await expect(service.inviteContact(admin, 'c1', 'ct1', {} as any)).rejects.toThrow(/already a staff member/);
    });

    it('creates a client-role membership + links the contact for a fresh email', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false, companyName: 'Acme' });
      contacts.findOne.mockResolvedValue({ id: 'ct1', clientId: 'c1', email: 'jane@acme.com', name: 'Jane Doe' });
      users.findOne.mockResolvedValue(null);
      users.save.mockImplementation((u: any) => Promise.resolve({ id: 'u1', ...u }));
      memberships.findOne.mockResolvedValue(null);
      const out = await service.inviteContact(admin, 'c1', 'ct1', {} as any);
      expect(out.status).toBe('active');
      expect(memberships.save).toHaveBeenCalledWith(expect.objectContaining({ role: 'client', personType: 'client', clientId: 'c1' }));
      expect(contacts.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
    });
  });

  describe('portalComment', () => {
    it('rejects a comment on a board that is not shared', async () => {
      memberships.findOne.mockResolvedValue({ userId: 'p1', clientId: 'c1', role: 'client', status: 'active' });
      shares.findOne.mockResolvedValue(null);
      await expect(service.portalComment('orgA', 'p1', 'b1', { text: 'hi' } as any)).rejects.toThrow(/not shared with you/);
    });

    it('rejects a comment when the share is view-only', async () => {
      memberships.findOne.mockResolvedValue({ userId: 'p1', clientId: 'c1', role: 'client', status: 'active' });
      shares.findOne.mockResolvedValue({ boardId: 'b1', clientId: 'c1', permission: 'view' });
      await expect(service.portalComment('orgA', 'p1', 'b1', { text: 'hi' } as any)).rejects.toThrow(/view-only/);
    });

    it('rejects an empty comment even with comment permission', async () => {
      memberships.findOne.mockResolvedValue({ userId: 'p1', clientId: 'c1', role: 'client', status: 'active' });
      shares.findOne.mockResolvedValue({ boardId: 'b1', clientId: 'c1', permission: 'comment' });
      await expect(service.portalComment('orgA', 'p1', 'b1', { text: '   ' } as any)).rejects.toThrow(/empty/);
    });

    it('stores a comment when permitted', async () => {
      memberships.findOne.mockResolvedValue({ userId: 'p1', clientId: 'c1', role: 'client', status: 'active' });
      shares.findOne.mockResolvedValue({ boardId: 'b1', clientId: 'c1', permission: 'comment' });
      users.findOne.mockResolvedValue({ id: 'p1', firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.com' });
      const out = await service.portalComment('orgA', 'p1', 'b1', { text: 'Looks good' } as any);
      expect(out.text).toBe('Looks good');
      expect(out.authorName).toBe('Jane Doe');
      expect(out.boardId).toBe('b1');
    });
  });

  describe('archive', () => {
    it('marks the client archived and deactivates its portal logins', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false, status: 'active' });
      const out = await service.archive('orgA', 'c1');
      expect(out.status).toBe('archived');
      expect(memberships.update).toHaveBeenCalledWith(
        { organizationId: 'orgA', role: 'client', clientId: 'c1' },
        { status: 'deactivated' },
      );
    });
  });

  describe('myClients', () => {
    it('maps assigned clients with their assignment role', async () => {
      assignments.find.mockResolvedValue([{ clientId: 'c1', userId: 'emp1', assignmentRole: 'Lead' }]);
      clients.find.mockResolvedValue([{ id: 'c1', companyName: 'Acme', organizationId: 'orgA', isDeleted: false }]);
      const out = await service.myClients('orgA', 'emp1');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ id: 'c1', assignmentRole: 'Lead' });
    });

    it('returns an empty list when the employee has no assignments', async () => {
      assignments.find.mockResolvedValue([]);
      const out = await service.myClients('orgA', 'emp1');
      expect(out).toEqual([]);
      expect(clients.find).not.toHaveBeenCalled();
    });
  });

  describe('createAgreement', () => {
    it('requires either body text or an attached PDF', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      await expect(service.createAgreement(admin, 'c1', { title: 'NDA' } as any)).rejects.toThrow(/text or attach a PDF/);
    });

    it('creates a draft agreement from body text', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', organizationId: 'orgA', isDeleted: false });
      const out = await service.createAgreement(admin, 'c1', { title: '  NDA  ', bodyHtml: '<p>terms</p>' } as any);
      expect(out.title).toBe('NDA');
      expect(out.status).toBe('draft');
      expect(out.clientId).toBe('c1');
    });
  });

  describe('sendAgreement', () => {
    it('moves a draft to sent and stamps sentAt', async () => {
      agreements.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', organizationId: 'orgA', isDeleted: false, status: 'draft', sentAt: null });
      const out = await service.sendAgreement('orgA', 'c1', 'a1');
      expect(out.status).toBe('sent');
      expect(out.sentAt).toBeInstanceOf(Date);
    });

    it('refuses to re-send a signed agreement', async () => {
      agreements.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', organizationId: 'orgA', isDeleted: false, status: 'signed' });
      await expect(service.sendAgreement('orgA', 'c1', 'a1')).rejects.toThrow(/already signed/);
    });
  });

  describe('signAgreement (portal)', () => {
    const portalMember = { userId: 'p1', clientId: 'c1', role: 'client', status: 'active' };

    it('records the signature + audit trail and moves to signed', async () => {
      memberships.findOne.mockResolvedValue(portalMember);
      agreements.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', organizationId: 'orgA', isDeleted: false, status: 'sent' });
      const out = await service.signAgreement('orgA', 'p1', 'a1', { signerName: 'Jane Doe', method: 'typed' } as any, '1.2.3.4', 'jest-ua');
      expect(out.status).toBe('signed');
      expect(out.signature).toMatchObject({ signerName: 'Jane Doe', signedByUserId: 'p1', ipAddress: '1.2.3.4', userAgent: 'jest-ua', method: 'typed' });
      expect(out.signedAt).toBeInstanceOf(Date);
    });

    it('rejects signing a draft (not yet sent) as not found', async () => {
      memberships.findOne.mockResolvedValue(portalMember);
      agreements.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', organizationId: 'orgA', isDeleted: false, status: 'draft' });
      await expect(service.signAgreement('orgA', 'p1', 'a1', { signerName: 'Jane' } as any)).rejects.toThrow(/not found/);
    });

    it('rejects a second signature on an already-signed agreement', async () => {
      memberships.findOne.mockResolvedValue(portalMember);
      agreements.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', organizationId: 'orgA', isDeleted: false, status: 'signed' });
      await expect(service.signAgreement('orgA', 'p1', 'a1', { signerName: 'Jane' } as any)).rejects.toThrow(/already signed/);
    });

    it('refuses when the caller has no client portal membership', async () => {
      memberships.findOne.mockResolvedValue(null);
      await expect(service.signAgreement('orgA', 'x', 'a1', { signerName: 'Jane' } as any)).rejects.toThrow(/portal access/);
    });
  });

  describe('portalAgreements', () => {
    it('lists only sent/signed agreements for the caller\'s client', async () => {
      memberships.findOne.mockResolvedValue({ userId: 'p1', clientId: 'c1', role: 'client', status: 'active' });
      agreements.find.mockResolvedValue([{ id: 'a1', clientId: 'c1', title: 'NDA', status: 'sent' }]);
      const out = await service.portalAgreements('orgA', 'p1');
      expect(out).toHaveLength(1);
      const where = agreements.find.mock.calls[0][0].where;
      expect(where.clientId).toBe('c1');
      // status filter is an In([...]) — drafts/voids are excluded
      expect(where.status).toBeDefined();
    });
  });

  describe('templates', () => {
    it('createTemplate requires body text or a PDF', async () => {
      await expect(service.createTemplate(admin, { name: 'NDA' } as any)).rejects.toThrow(/text or attach a PDF/);
    });
    it('creates a template from body text', async () => {
      const out = await service.createTemplate(admin, { name: 'Std NDA', bodyHtml: '<p>terms</p>', category: 'nda' } as any);
      expect(out.name).toBe('Std NDA');
      expect(out.organizationId).toBe('orgA');
    });
  });

  describe('remindAgreement (manual)', () => {
    it('refuses to remind an agreement that is not sent', async () => {
      agreements.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', organizationId: 'orgA', isDeleted: false, status: 'signed' });
      await expect(service.remindAgreement('orgA', 'c1', 'a1')).rejects.toThrow(/sent, unsigned/);
    });
    it('notifies the client portal users and stamps the reminder', async () => {
      agreements.findOne.mockResolvedValue({ id: 'a1', clientId: 'c1', organizationId: 'orgA', isDeleted: false, status: 'sent', title: 'NDA', reminderCount: 0 });
      clients.findOne.mockResolvedValue({ id: 'c1', companyName: 'Acme' });
      memberships.find.mockResolvedValue([{ userId: 'p1' }]);
      const out = await service.remindAgreement('orgA', 'c1', 'a1');
      expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'client_agreement_reminder', userId: 'p1' }));
      expect(out.reminderCount).toBe(1);
      expect(out.lastReminderAt).toBeInstanceOf(Date);
    });
  });

  describe('runAgreementReminders (cron)', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    it('reminds a sent agreement past the threshold and stamps it', async () => {
      agreements.find.mockResolvedValue([{ id: 'a1', clientId: 'c1', organizationId: 'orgA', title: 'NDA', status: 'sent', isDeleted: false, sentAt: daysAgo(5), lastReminderAt: null, reminderCount: 0 }]);
      clients.findOne.mockResolvedValue({ id: 'c1', companyName: 'Acme' });
      memberships.find.mockResolvedValue([{ userId: 'p1' }]);
      const r = await service.runAgreementReminders(new Date());
      expect(r.notified).toBe(1);
      expect(notifier.notify).toHaveBeenCalled();
      expect(agreements.save).toHaveBeenCalledWith(expect.objectContaining({ reminderCount: 1 }));
    });
    it('skips a recently-reminded agreement', async () => {
      agreements.find.mockResolvedValue([{ id: 'a1', clientId: 'c1', organizationId: 'orgA', status: 'sent', isDeleted: false, sentAt: daysAgo(10), lastReminderAt: daysAgo(1), reminderCount: 1 }]);
      const r = await service.runAgreementReminders(new Date());
      expect(r.notified).toBe(0);
      expect(notifier.notify).not.toHaveBeenCalled();
    });
    it('stops after the max number of reminders', async () => {
      agreements.find.mockResolvedValue([{ id: 'a1', clientId: 'c1', organizationId: 'orgA', status: 'sent', isDeleted: false, sentAt: daysAgo(30), lastReminderAt: daysAgo(10), reminderCount: 3 }]);
      const r = await service.runAgreementReminders(new Date());
      expect(r.notified).toBe(0);
    });
  });
});
