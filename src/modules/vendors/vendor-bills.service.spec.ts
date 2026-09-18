import { VendorBillsService } from './vendor-bills.service';

/**
 * Pure unit tests for VendorBillsService — repos are mocked. These lock the two
 * rules the money depends on: totals are computed here (never taken from the
 * client), and a bill stops being editable the moment it is approved.
 */
describe('VendorBillsService', () => {
  let vendors: any, people: any, bills: any;
  let service: VendorBillsService;

  const admin = { userId: 'owner1', orgId: 'orgA', isAdmin: true };
  const vendor = (over: Record<string, unknown> = {}) => ({
    id: 'v1', organizationId: 'orgA', companyName: 'Acme Contractors', currency: 'INR', isDeleted: false, ...over,
  });
  const bill = (over: Record<string, unknown> = {}) => ({
    id: 'b1', organizationId: 'orgA', vendorId: 'v1', billNumber: 'VB-00001', status: 'draft',
    lineItems: [{ description: 'Amit — Aug', quantity: 20, unit: 'day', rate: 8000, amount: 160000 }],
    currency: 'INR', subtotal: '160000.00', taxPercent: '18.000', taxAmount: '28800.00', total: '188800.00',
    issueDate: new Date(), dueDate: null, approvedAt: null, approvedBy: null, paidAt: null, paidBy: null,
    paymentReference: null, cancelReason: null, isDeleted: false, ...over,
  });

  beforeEach(() => {
    const repo = () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn((v) => Promise.resolve({ id: v.id ?? 'new1', ...v })),
      create: jest.fn((v) => ({ ...v })),
      count: jest.fn().mockResolvedValue(0),
    });
    vendors = repo(); people = repo(); bills = repo();
    vendors.findOne.mockResolvedValue(vendor());
    service = new VendorBillsService(vendors, people, bills);
  });

  describe('create', () => {
    it('computes every amount itself and ignores what the client would suggest', async () => {
      const out = await service.create(admin, 'v1', {
        lineItems: [
          { description: 'Amit — Aug', quantity: 20, rate: 8000, unit: 'day', amount: 1 } as any,
          { description: 'Priya — Aug', quantity: 10.5, rate: 1000, unit: 'day' } as any,
        ],
        taxPercent: 18,
      } as any);
      expect(out.lineItems.map((l) => l.amount)).toEqual([160000, 10500]);
      expect(out.subtotal).toBe(170500);
      expect(out.taxAmount).toBe(30690);
      expect(out.total).toBe(201190);
    });

    it('rounds money to two decimals rather than carrying float dust', async () => {
      const out = await service.create(admin, 'v1', {
        lineItems: [{ description: 'Hours', quantity: 3, rate: 33.33, unit: 'hour' }],
        taxPercent: 7.5,
      } as any);
      expect(out.lineItems[0].amount).toBe(99.99);
      expect(out.taxAmount).toBe(7.5);
      expect(out.total).toBe(107.49);
    });

    it('starts as a draft, numbered per org, in the vendor’s currency', async () => {
      bills.count.mockResolvedValue(6);
      const out = await service.create(admin, 'v1', { lineItems: [{ description: 'x', quantity: 1, rate: 100 }] } as any);
      expect(out).toMatchObject({ status: 'draft', billNumber: 'VB-00007', currency: 'INR', vendorName: 'Acme Contractors' });
    });

    it('takes the next number when the first one collides', async () => {
      bills.count.mockResolvedValue(0);
      bills.save
        .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
        .mockImplementation((v: any) => Promise.resolve({ id: 'b2', ...v }));
      const out = await service.create(admin, 'v1', { lineItems: [{ description: 'x', quantity: 1, rate: 100 }] } as any);
      expect(out.billNumber).toBe('VB-00002');
    });

    it('refuses an empty bill', async () => {
      await expect(service.create(admin, 'v1', { lineItems: [] } as any)).rejects.toThrow(/at least one line/);
    });

    it('refuses negative quantities or rates', async () => {
      await expect(service.create(admin, 'v1', { lineItems: [{ description: 'x', quantity: -1, rate: 10 }] } as any))
        .rejects.toThrow(/cannot be negative/);
    });

    it('refuses a line for someone this vendor does not supply', async () => {
      people.find.mockResolvedValue([]); // the id resolves to nobody at this vendor
      await expect(service.create(admin, 'v1', {
        lineItems: [{ description: 'Ghost', quantity: 1, rate: 100, vendorEmployeeId: 'e404' }],
      } as any)).rejects.toThrow(/does not supply/);
    });

    it('names the line after the supplied person when no description is given', async () => {
      people.find.mockResolvedValue([{ id: 'e1', name: 'Amit Sharma' }]);
      const out = await service.create(admin, 'v1', {
        lineItems: [{ quantity: 2, rate: 5000, vendorEmployeeId: 'e1' }],
      } as any);
      expect(out.lineItems[0]).toMatchObject({ description: 'Amit Sharma', contractorName: 'Amit Sharma', amount: 10000 });
    });
  });

  describe('update', () => {
    it('recomputes the totals when the lines change', async () => {
      bills.findOne.mockResolvedValue(bill());
      const out = await service.update('orgA', 'b1', {
        lineItems: [{ description: 'Amit — Aug (corrected)', quantity: 18, rate: 8000, unit: 'day' }],
      } as any);
      expect(out.subtotal).toBe(144000);
      expect(out.taxAmount).toBe(25920); // the 18% already on the bill still applies
      expect(out.total).toBe(169920);
    });

    it('will not edit a bill that has been approved', async () => {
      bills.findOne.mockResolvedValue(bill({ status: 'approved' }));
      await expect(service.update('orgA', 'b1', { period: 'Sep 2026' } as any))
        .rejects.toThrow(/approved bill cannot be edited/);
    });
  });

  describe('approve', () => {
    it('records who approved it and when', async () => {
      bills.findOne.mockResolvedValue(bill());
      const out = await service.approve(admin, 'b1');
      expect(out.status).toBe('approved');
      expect(out.approvedBy).toBe('owner1');
      expect(out.approvedAt).toBeInstanceOf(Date);
    });

    it('is idempotent, so a double click does not re-stamp the approval', async () => {
      const already = bill({ status: 'approved', approvedBy: 'someone-else', approvedAt: new Date('2026-01-01') });
      bills.findOne.mockResolvedValue(already);
      const out = await service.approve(admin, 'b1');
      expect(out.approvedBy).toBe('someone-else');
      expect(bills.save).not.toHaveBeenCalled();
    });

    it('will not approve an empty or cancelled bill', async () => {
      bills.findOne.mockResolvedValue(bill({ lineItems: [] }));
      await expect(service.approve(admin, 'b1')).rejects.toThrow(/empty bill/);
      bills.findOne.mockResolvedValue(bill({ status: 'cancelled' }));
      await expect(service.approve(admin, 'b1')).rejects.toThrow(/cancelled bill cannot be approved/);
    });
  });

  describe('markPaid', () => {
    it('records the payment reference and who paid', async () => {
      bills.findOne.mockResolvedValue(bill({ status: 'approved' }));
      const out = await service.markPaid(admin, 'b1', { paymentReference: 'UTR-99' } as any);
      expect(out).toMatchObject({ status: 'paid', paidBy: 'owner1', paymentReference: 'UTR-99' });
    });

    it('insists the bill was approved first', async () => {
      bills.findOne.mockResolvedValue(bill({ status: 'draft' }));
      await expect(service.markPaid(admin, 'b1', {} as any)).rejects.toThrow(/Approve the bill/);
    });

    it('refuses a payment dated in the future', async () => {
      bills.findOne.mockResolvedValue(bill({ status: 'approved' }));
      const future = new Date(Date.now() + 86_400_000).toISOString();
      await expect(service.markPaid(admin, 'b1', { paidAt: future } as any)).rejects.toThrow(/future/);
    });
  });

  describe('cancel and delete', () => {
    it('cancels an approved bill with a reason', async () => {
      bills.findOne.mockResolvedValue(bill({ status: 'approved' }));
      const out = await service.cancel('orgA', 'b1', { reason: 'Duplicate of VB-00003' } as any);
      expect(out).toMatchObject({ status: 'cancelled', cancelReason: 'Duplicate of VB-00003' });
    });

    it('will not cancel a paid bill', async () => {
      bills.findOne.mockResolvedValue(bill({ status: 'paid' }));
      await expect(service.cancel('orgA', 'b1', {} as any)).rejects.toThrow(/paid bill cannot be cancelled/);
    });

    it('deletes only a draft; anything agreed is a record', async () => {
      bills.findOne.mockResolvedValue(bill());
      expect(await service.remove('orgA', 'b1')).toEqual({ id: 'b1' });
      bills.findOne.mockResolvedValue(bill({ status: 'approved' }));
      await expect(service.remove('orgA', 'b1')).rejects.toThrow(/cancel it instead/);
    });
  });

  describe('costSummary', () => {
    it('separates what we owe from what we have paid, ignoring cancelled bills', async () => {
      bills.find.mockResolvedValue([
        bill({ status: 'draft', total: '1000.00' }),
        bill({ status: 'approved', total: '2000.00' }),
        bill({ status: 'approved', total: '500.00' }),
        bill({ status: 'paid', total: '7000.00' }),
        bill({ status: 'cancelled', total: '9999.00' }),
      ]);
      expect(await service.costSummary('orgA', 'v1')).toEqual({
        currency: 'INR', bills: 4, draft: 1000, approved: 2500, paid: 7000,
        outstanding: 2500, committed: 9500, lifetime: 10500,
      });
    });
  });

  describe('scoping', () => {
    it('never reaches another org’s vendor or bill', async () => {
      vendors.findOne.mockResolvedValue(null);
      await expect(service.create(admin, 'v1', { lineItems: [{ description: 'x', quantity: 1, rate: 1 }] } as any))
        .rejects.toThrow(/Vendor not found/);
      bills.findOne.mockResolvedValue(null);
      await expect(service.get('orgB', 'b1')).rejects.toThrow(/Bill not found/);
    });
  });
});
