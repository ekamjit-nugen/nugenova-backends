import { VendorAgreementsService } from './vendor-agreements.service';

/**
 * Pure unit tests for VendorAgreementsService — repos are mocked, so these lock
 * the rules that decide whether a vendor is cleared to supply people: which
 * templates apply, what counts as signed, and how `onboardingStatus` follows.
 * The HTTP surface is covered by features/vendor-agreements.e2e-spec.ts.
 */
describe('VendorAgreementsService', () => {
  let vendors: any, agreements: any, templates: any;
  let service: VendorAgreementsService;

  const admin = { userId: 'owner1', orgId: 'orgA', isAdmin: true };
  const vendor = (over: Record<string, unknown> = {}) => ({
    id: 'v1', organizationId: 'orgA', isDeleted: false, serviceCategory: 'Staffing',
    onboardingStatus: 'invited', onboardedAt: null, ...over,
  });
  const template = (over: Record<string, unknown> = {}) => ({
    id: 't1', organizationId: 'orgA', name: 'MSA', title: null, category: 'msa',
    bodyHtml: '<p>terms</p>', sourceFileId: null, fields: null, required: true,
    appliesToCategories: [], isArchived: false, isDeleted: false, ...over,
  });
  const agreement = (over: Record<string, unknown> = {}) => ({
    id: 'a1', organizationId: 'orgA', vendorId: 'v1', templateId: 't1', title: 'MSA',
    bodyHtml: '<p>terms</p>', sourceFileId: null, status: 'sent', requiredForOnboarding: true,
    signature: null, sentAt: new Date(), signedAt: null, expiresAt: null, isDeleted: false,
    waived: false, waivedReason: null, waivedAt: null, waivedBy: null, ...over,
  });

  beforeEach(() => {
    const repo = () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn((v) => Promise.resolve({ id: v.id ?? 'new1', ...v })),
      create: jest.fn((v) => ({ ...v })),
      count: jest.fn().mockResolvedValue(0),
    });
    vendors = repo(); agreements = repo(); templates = repo();
    vendors.findOne.mockResolvedValue(vendor());
    service = new VendorAgreementsService(vendors, agreements, templates);
  });

  describe('create', () => {
    it('copies the template content instead of pointing at it', async () => {
      // A later edit to the template must not change what a vendor agreed to.
      templates.findOne.mockResolvedValue(template({ title: 'Master Services Agreement', fields: [{ key: 'sig' }] }));
      const out = await service.create(admin, 'v1', { templateId: 't1' } as any);
      expect(out).toMatchObject({
        templateId: 't1', title: 'Master Services Agreement', bodyHtml: '<p>terms</p>',
        category: 'msa', requiredForOnboarding: true, status: 'draft',
      });
      expect(out.fields).toEqual([{ key: 'sig' }]);
    });

    it('needs text or a PDF', async () => {
      await expect(service.create(admin, 'v1', { title: 'Empty' } as any)).rejects.toThrow(/text or attach a PDF/);
    });

    it('needs a title when there is no template to take one from', async () => {
      await expect(service.create(admin, 'v1', { bodyHtml: '<p>x</p>' } as any)).rejects.toThrow(/needs a title/);
    });
  });

  describe('issueRequired', () => {
    it('raises only the required templates that apply and are missing', async () => {
      vendors.findOne.mockResolvedValue(vendor({ serviceCategory: 'Staffing' }));
      templates.find.mockResolvedValue([
        template({ id: 't1', name: 'MSA' }),                                              // applies to all
        template({ id: 't2', name: 'Background checks', appliesToCategories: ['staffing'] }), // matches, case-insensitively
        template({ id: 't3', name: 'Facilities addendum', appliesToCategories: ['Facilities'] }), // other category
        template({ id: 't4', name: 'Optional guide', required: false }),
      ]);
      agreements.find.mockResolvedValue([agreement({ id: 'a1', templateId: 't1' })]); // MSA already issued
      templates.findOne.mockImplementation(({ where }: any) => Promise.resolve(template({ id: where.id, name: where.id })));

      const out = await service.issueRequired(admin, 'v1');
      expect(out.created).toBe(1);
      expect(out.agreements[0].templateId).toBe('t2');
    });

    it('re-issues a template whose only agreement was voided', async () => {
      templates.find.mockResolvedValue([template({ id: 't1' })]);
      agreements.find.mockResolvedValue([agreement({ id: 'a1', templateId: 't1', status: 'void' })]);
      templates.findOne.mockResolvedValue(template({ id: 't1' }));
      expect((await service.issueRequired(admin, 'v1')).created).toBe(1);
    });
  });

  describe('sign', () => {
    it('records who signed, how, and from where', async () => {
      agreements.findOne.mockResolvedValue(agreement());
      const out = await service.sign(admin, 'v1', 'a1', { signerName: '  Riya Verma ' } as any, '10.0.0.1', 'curl/8');
      expect(out.status).toBe('signed');
      expect(out.signature).toMatchObject({
        signerName: 'Riya Verma', signedByUserId: 'owner1', ipAddress: '10.0.0.1', userAgent: 'curl/8',
        method: 'offline', // no drawn signature file → recorded on the vendor's behalf
      });
    });

    it('accepts a backdated signing date for a paper signature', async () => {
      agreements.findOne.mockResolvedValue(agreement());
      const out = await service.sign(admin, 'v1', 'a1', { signerName: 'Riya', signedAt: '2026-01-05T00:00:00.000Z' } as any);
      expect(out.signedAt?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    });

    it('refuses a signing date in the future', async () => {
      agreements.findOne.mockResolvedValue(agreement());
      const future = new Date(Date.now() + 86_400_000).toISOString();
      await expect(service.sign(admin, 'v1', 'a1', { signerName: 'Riya', signedAt: future } as any)).rejects.toThrow(/future/);
    });

    it('refuses to sign twice, or to sign a voided agreement', async () => {
      agreements.findOne.mockResolvedValue(agreement({ status: 'signed' }));
      await expect(service.sign(admin, 'v1', 'a1', { signerName: 'Riya' } as any)).rejects.toThrow(/already signed/);
      agreements.findOne.mockResolvedValue(agreement({ status: 'void' }));
      await expect(service.sign(admin, 'v1', 'a1', { signerName: 'Riya' } as any)).rejects.toThrow(/voided/);
    });
  });

  describe('edit and delete guards', () => {
    it('will not edit or void a signed agreement', async () => {
      agreements.findOne.mockResolvedValue(agreement({ status: 'signed' }));
      await expect(service.update('orgA', 'v1', 'a1', { title: 'New' } as any)).rejects.toThrow(/cannot be edited/);
      await expect(service.void('orgA', 'v1', 'a1')).rejects.toThrow(/cannot be voided/);
    });

    it('keeps a signed agreement as a record rather than deleting it', async () => {
      agreements.findOne.mockResolvedValue(agreement({ status: 'signed' }));
      await expect(service.remove('orgA', 'v1', 'a1')).rejects.toThrow(/void it instead/);
    });
  });

  describe('deleteTemplate', () => {
    it('archives a template that has been issued', async () => {
      templates.findOne.mockResolvedValue(template());
      agreements.count.mockResolvedValue(3);
      expect(await service.deleteTemplate('orgA', 't1')).toEqual({ id: 't1', archived: true });
      expect(templates.save).toHaveBeenCalledWith(expect.objectContaining({ isArchived: true, isDeleted: false }));
    });

    it('deletes one that was never used', async () => {
      templates.findOne.mockResolvedValue(template());
      agreements.count.mockResolvedValue(0);
      expect(await service.deleteTemplate('orgA', 't1')).toEqual({ id: 't1', archived: false });
      expect(templates.save).toHaveBeenCalledWith(expect.objectContaining({ isDeleted: true }));
    });
  });

  describe('clearance', () => {
    it('lists a required template with no agreement as missing', async () => {
      templates.find.mockResolvedValue([template()]);
      agreements.find.mockResolvedValue([]);
      const out = await service.clearance('orgA', 'v1');
      expect(out).toMatchObject({ cleared: false, outstanding: 1 });
      expect(out.items[0]).toMatchObject({ templateId: 't1', agreementId: null, status: 'missing' });
    });

    it('clears the vendor once every required agreement is signed', async () => {
      templates.find.mockResolvedValue([template()]);
      agreements.find.mockResolvedValue([agreement({ status: 'signed', signedAt: new Date('2026-02-01') })]);
      expect(await service.clearance('orgA', 'v1')).toMatchObject({ cleared: true, outstanding: 0 });
    });

    it('treats a signed agreement past its expiry as expired', async () => {
      templates.find.mockResolvedValue([template()]);
      agreements.find.mockResolvedValue([agreement({ status: 'signed', expiresAt: new Date('2026-01-01') })]);
      const out = await service.clearance('orgA', 'v1', new Date('2026-06-01'));
      expect(out.items[0].status).toBe('expired');
      expect(out.cleared).toBe(false);
    });

    it('ignores templates aimed at another service category', async () => {
      vendors.findOne.mockResolvedValue(vendor({ serviceCategory: 'Facilities' }));
      templates.find.mockResolvedValue([template({ appliesToCategories: ['Staffing'] })]);
      agreements.find.mockResolvedValue([]);
      expect(await service.clearance('orgA', 'v1')).toMatchObject({ cleared: true, outstanding: 0 });
    });

    it('still counts a required agreement whose template was archived or made optional', async () => {
      templates.find.mockResolvedValue([]); // template no longer required/listed
      agreements.find.mockResolvedValue([agreement({ requiredForOnboarding: true, status: 'sent' })]);
      const out = await service.clearance('orgA', 'v1');
      expect(out).toMatchObject({ cleared: false, outstanding: 1 });
      expect(out.items[0]).toMatchObject({ agreementId: 'a1', status: 'sent' });
    });

    it('does not count a voided agreement against the vendor', async () => {
      templates.find.mockResolvedValue([]);
      agreements.find.mockResolvedValue([agreement({ requiredForOnboarding: true, status: 'void' })]);
      expect(await service.clearance('orgA', 'v1')).toMatchObject({ cleared: true, outstanding: 0 });
    });
  });

  describe('waiving a required agreement', () => {
    it('records the reason and who decided it', async () => {
      agreements.findOne.mockResolvedValue(agreement());
      const out = await service.waive(admin, 'v1', 'a1', { reason: 'Vendor signs their own MSA only' } as any);
      expect(out).toMatchObject({ waived: true, waivedReason: 'Vendor signs their own MSA only', waivedBy: 'owner1' });
      expect(out.waivedAt).toBeInstanceOf(Date);
    });

    it('insists on a reason', async () => {
      agreements.findOne.mockResolvedValue(agreement());
      await expect(service.waive(admin, 'v1', 'a1', { reason: '   ' } as any)).rejects.toThrow(/reason/);
    });

    it('will not waive something already signed', async () => {
      agreements.findOne.mockResolvedValue(agreement({ status: 'signed' }));
      await expect(service.waive(admin, 'v1', 'a1', { reason: 'no need' } as any)).rejects.toThrow(/already signed/);
    });

    it('clears the vendor without the signature', async () => {
      templates.find.mockResolvedValue([template()]);
      agreements.find.mockResolvedValue([agreement({ waived: true, waivedReason: 'Signed on paper years ago' })]);
      const out = await service.clearance('orgA', 'v1');
      expect(out).toMatchObject({ cleared: true, outstanding: 0 });
      expect(out.items[0]).toMatchObject({ status: 'waived', waivedReason: 'Signed on paper years ago' });
    });

    it('puts it back on the checklist when un-waived', async () => {
      agreements.findOne.mockResolvedValue(agreement({ waived: true, waivedReason: 'was fine' }));
      templates.find.mockResolvedValue([template()]);
      agreements.find.mockResolvedValue([agreement()]);
      const out = await service.unwaive('orgA', 'v1', 'a1');
      expect(out).toMatchObject({ waived: false, waivedReason: null, waivedBy: null });
    });

    it('refuses to un-waive one that was never waived', async () => {
      agreements.findOne.mockResolvedValue(agreement());
      await expect(service.unwaive('orgA', 'v1', 'a1')).rejects.toThrow(/not waived/);
    });

    it('a signature still outranks a waiver in the report', async () => {
      templates.find.mockResolvedValue([template()]);
      agreements.find.mockResolvedValue([agreement({ status: 'signed', waived: true })]);
      expect((await service.clearance('orgA', 'v1')).items[0].status).toBe('signed');
    });
  });

  describe('onboarding status follows clearance', () => {
    it('moves to agreements_pending while something is outstanding', async () => {
      templates.find.mockResolvedValue([template()]);
      agreements.find.mockResolvedValue([]);
      agreements.findOne.mockResolvedValue(agreement());
      await service.send('orgA', 'v1', 'a1');
      expect(vendors.save).toHaveBeenCalledWith(expect.objectContaining({ onboardingStatus: 'agreements_pending' }));
    });

    it('moves to active and stamps onboardedAt when the last one is signed', async () => {
      templates.find.mockResolvedValue([template()]);
      agreements.findOne.mockResolvedValue(agreement());
      agreements.find.mockResolvedValue([agreement({ status: 'signed' })]);
      vendors.findOne.mockResolvedValue(vendor({ onboardingStatus: 'agreements_pending' }));
      await service.sign(admin, 'v1', 'a1', { signerName: 'Riya' } as any);
      const saved = vendors.save.mock.calls.at(-1)[0];
      expect(saved.onboardingStatus).toBe('active');
      expect(saved.onboardedAt).toBeInstanceOf(Date);
    });

    it('leaves a suspended vendor suspended — suspension is a decision, not paperwork', async () => {
      vendors.findOne.mockResolvedValue(vendor({ onboardingStatus: 'suspended' }));
      templates.find.mockResolvedValue([template()]);
      agreements.findOne.mockResolvedValue(agreement());
      agreements.find.mockResolvedValue([agreement({ status: 'signed' })]);
      await service.sign(admin, 'v1', 'a1', { signerName: 'Riya' } as any);
      expect(vendors.save).not.toHaveBeenCalled();
    });
  });
});
