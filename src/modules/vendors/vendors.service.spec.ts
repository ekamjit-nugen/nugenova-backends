import { VendorsService } from './vendors.service';

/**
 * Pure unit tests for VendorsService — repos are mocked, so these lock the
 * branching/validation logic (dedup, trimming, primary-contact exclusivity,
 * cascade delete, stats maths) without a database. End-to-end behaviour and the
 * permission gates are covered by features/vendors.e2e-spec.ts.
 */
describe('VendorsService', () => {
  let vendors: any, contacts: any, people: any;
  let service: VendorsService;

  const admin = { userId: 'owner1', orgId: 'orgA', isAdmin: true };
  const liveVendor = { id: 'v1', organizationId: 'orgA', isDeleted: false, onboardingStatus: 'invited', onboardedAt: null, currency: 'INR' };

  beforeEach(() => {
    const repo = () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn((v) => Promise.resolve({ id: 'new1', ...v })),
      create: jest.fn((v) => ({ ...v })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    vendors = repo(); contacts = repo(); people = repo();
    service = new VendorsService(vendors, contacts, people);
  });

  describe('create', () => {
    it('creates a vendor when the name is unique', async () => {
      vendors.findOne.mockResolvedValue(null);
      const out = await service.create(admin, { companyName: '  Acme Contractors  ', currency: 'inr' } as any);
      expect(out.companyName).toBe('Acme Contractors'); // trimmed
      expect(out.currency).toBe('INR');
      expect(out.status).toBe('active');
      expect(out.onboardingStatus).toBe('invited');
      expect(out.organizationId).toBe('orgA');
      // A vendor is not cleared to supply people the moment it is created.
      expect(out.onboardedAt).toBeNull();
      expect(out.timeTrackingEnabled).toBe(false);
    });

    it('rejects a duplicate company name with a conflict', async () => {
      vendors.findOne.mockResolvedValue({ id: 'v1' });
      await expect(service.create(admin, { companyName: 'Acme Contractors' } as any)).rejects.toThrow(/already exists/);
      expect(vendors.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('stamps onboardedAt the first time the vendor goes active', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      const out = await service.update(admin, 'v1', { onboardingStatus: 'active' } as any);
      expect(out.onboardedAt).toBeInstanceOf(Date);
    });

    it('keeps the original onboardedAt when a suspended vendor goes active again', async () => {
      const first = new Date('2026-01-01T00:00:00Z');
      vendors.findOne.mockResolvedValue({ ...liveVendor, onboardingStatus: 'suspended', onboardedAt: first });
      const out = await service.update(admin, 'v1', { onboardingStatus: 'active' } as any);
      expect(out.onboardedAt).toBe(first);
    });

    it('rejects renaming onto another live vendor', async () => {
      vendors.findOne
        .mockResolvedValueOnce({ ...liveVendor })          // the vendor being edited
        .mockResolvedValueOnce({ id: 'v2', isDeleted: false }); // the name clash
      await expect(service.update(admin, 'v1', { companyName: 'Other Partners' } as any)).rejects.toThrow(/already exists/);
    });

    it('allows a vendor to keep its own name', async () => {
      vendors.findOne
        .mockResolvedValueOnce({ ...liveVendor })
        .mockResolvedValueOnce({ id: 'v1', isDeleted: false });
      const out = await service.update(admin, 'v1', { companyName: 'Acme Contractors' } as any);
      expect(out.companyName).toBe('Acme Contractors');
    });

    it('reports a missing vendor rather than creating one', async () => {
      vendors.findOne.mockResolvedValue(null);
      await expect(service.update(admin, 'nope', {} as any)).rejects.toThrow(/not found/);
    });
  });

  describe('remove', () => {
    it('soft-deletes the vendor and everything under it', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      await service.remove(admin, 'v1');
      expect(vendors.save).toHaveBeenCalledWith(expect.objectContaining({ isDeleted: true }));
      expect(contacts.update).toHaveBeenCalledWith({ organizationId: 'orgA', vendorId: 'v1' }, { isDeleted: true });
      expect(people.update).toHaveBeenCalledWith({ organizationId: 'orgA', vendorId: 'v1' }, { isDeleted: true });
    });
  });

  describe('contacts', () => {
    it('demotes the previous primary before adding a new one', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      await service.addContact('orgA', 'v1', { name: 'Neha', isPrimary: true } as any);
      expect(contacts.update).toHaveBeenCalledWith({ organizationId: 'orgA', vendorId: 'v1', isPrimary: true }, { isPrimary: false });
    });

    it('leaves the primary alone when the new contact is not primary', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      await service.addContact('orgA', 'v1', { name: 'Neha' } as any);
      expect(contacts.update).not.toHaveBeenCalled();
    });

    it('lowercases the email so duplicates and lookups agree', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      const out = await service.addContact('orgA', 'v1', { name: 'Riya', email: 'Riya@Acme.TEST' } as any);
      expect(out.email).toBe('riya@acme.test');
    });
  });

  describe('vendor employees', () => {
    it('adds a contractor with the vendor rate', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      people.findOne.mockResolvedValue(null);
      const out = await service.addEmployee('orgA', 'v1', { name: 'Amit Sharma', email: 'A@acme.test', rateAmount: 8000, rateUnit: 'day' } as any);
      expect(out).toMatchObject({ vendorId: 'v1', email: 'a@acme.test', rateAmount: 8000, rateUnit: 'day', rateCurrency: 'INR', status: 'active' });
    });

    it('rejects the same email twice at one vendor', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      people.findOne.mockResolvedValue({ id: 'e1' });
      await expect(service.addEmployee('orgA', 'v1', { name: 'Amit', email: 'a@acme.test' } as any)).rejects.toThrow(/already has someone/);
    });

    it('does not check for duplicates when no email is given', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      await service.addEmployee('orgA', 'v1', { name: 'Amit' } as any);
      expect(people.findOne).not.toHaveBeenCalled();
    });

    it('never reaches another org’s vendor', async () => {
      vendors.findOne.mockResolvedValue(null);
      await expect(service.addEmployee('orgB', 'v1', { name: 'Amit' } as any)).rejects.toThrow(/not found/);
      expect(people.save).not.toHaveBeenCalled();
    });

    it('filters the people list by skill, case-insensitively', async () => {
      vendors.findOne.mockResolvedValue({ ...liveVendor });
      people.find.mockResolvedValue([
        { id: 'e1', skills: ['React', 'Node'] },
        { id: 'e2', skills: ['Java'] },
        { id: 'e3', skills: [] },
      ]);
      const out = await service.listEmployees('orgA', 'v1', { skill: 'react' });
      expect(out.map((r: any) => r.id)).toEqual(['e1']);
    });
  });

  describe('stats', () => {
    it('counts only active people from live vendors', async () => {
      vendors.find.mockResolvedValue([
        { id: 'v1', status: 'active', onboardingStatus: 'active' },
        { id: 'v2', status: 'archived', onboardingStatus: 'suspended' },
        { id: 'v3', status: 'active', onboardingStatus: 'agreements_pending' },
      ]);
      people.find.mockResolvedValue([
        { vendorId: 'v1', status: 'active' },
        { vendorId: 'v1', status: 'inactive' },
        { vendorId: 'v2', status: 'active' }, // archived vendor — not supplying
      ]);
      expect(await service.stats('orgA')).toEqual({ total: 3, active: 2, onboardingPending: 1, suspended: 1, people: 1 });
    });
  });

  describe('list', () => {
    it('attaches contact and active-people counts', async () => {
      vendors.find.mockResolvedValue([{ id: 'v1', tags: [] }, { id: 'v2', tags: [] }]);
      contacts.find.mockResolvedValue([{ vendorId: 'v1' }, { vendorId: 'v1' }]);
      people.find.mockResolvedValue([{ vendorId: 'v1', status: 'active' }, { vendorId: 'v2', status: 'inactive' }]);
      const out = await service.list('orgA', {});
      expect(out[0].counts).toEqual({ contacts: 2, activePeople: 1 });
      expect(out[1].counts).toEqual({ contacts: 0, activePeople: 0 });
    });

    it('filters by tag in memory, keeping the DB query simple', async () => {
      vendors.find.mockResolvedValue([{ id: 'v1', tags: ['preferred'] }, { id: 'v2', tags: [] }]);
      const out = await service.list('orgA', { tag: 'preferred' });
      expect(out.map((v: any) => v.id)).toEqual(['v1']);
    });
  });
});
