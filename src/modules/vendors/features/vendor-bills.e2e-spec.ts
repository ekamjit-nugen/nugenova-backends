import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness, randomEmail } from '../../organization/features/support/org-harness';
import { VendorEntity } from '../entities/vendor.entity';
import { VendorEmployeeEntity } from '../entities/vendor-employee.entity';
import { VendorBillEntity } from '../entities/vendor-bill.entity';

const feature = loadFeature('./vendor-bills.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let vendors: Repository<VendorEntity>;
  let people: Repository<VendorEmployeeEntity>;
  let bills: Repository<VendorBillEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    vendors = h.app.get(getRepositoryToken(VendorEntity));
    people = h.app.get(getRepositoryToken(VendorEmployeeEntity));
    bills = h.app.get(getRepositoryToken(VendorBillEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      await bills.delete({ organizationId: In(oids) }).catch(() => undefined);
      await people.delete({ organizationId: In(oids) }).catch(() => undefined);
      await vendors.delete({ organizationId: In(oids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const as = (token: string) => ({
    get: (path: string) => h.api().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => h.api().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object = {}) => h.api().patch(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
  });

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  const addVendor = async (o: CreatedOrg, companyName = 'Acme Contractors'): Promise<string> =>
    (await as(o.ownerToken).post('/vendors', { companyName, serviceCategory: 'Staffing' }).expect(201)).body.data.id;

  const addPerson = async (o: CreatedOrg, vendorId: string, name = 'Amit Sharma'): Promise<string> =>
    (await as(o.ownerToken).post(`/vendors/${vendorId}/employees`, { name, rateAmount: 8000, rateUnit: 'day' }).expect(201)).body.data.id;

  const raiseBill = (o: CreatedOrg, vendorId: string, body: object) => as(o.ownerToken).post(`/vendors/${vendorId}/bills`, body);

  // Shared scenario state.
  let org: CreatedOrg;
  let vendorId: string;
  let personId: string;
  let billId: string;
  let res: request.Response;

  const givenVendorWithPerson = async () => {
    org = await newOrg();
    vendorId = await addVendor(org);
    personId = await addPerson(org, vendorId);
  };

  const givenDraftBill = async () => {
    const created = await raiseBill(org, vendorId, {
      period: 'Aug 2026',
      taxPercent: 18,
      lineItems: [{ description: 'Amit — Aug', vendorEmployeeId: personId, quantity: 20, unit: 'day', rate: 8000 }],
    }).expect(201);
    billId = created.body.data.id;
  };

  test('an admin raises a bill for the people a vendor supplied', ({ given, when, then, and }) => {
    given('an organization with a vendor "Acme Contractors" supplying "Amit Sharma"', givenVendorWithPerson);
    when('the owner raises a bill for 20 days of "Amit Sharma" at 8000 with 18% tax', async () => {
      res = await raiseBill(org, vendorId, {
        period: 'Aug 2026',
        taxPercent: 18,
        lineItems: [{ description: 'Amit — Aug', vendorEmployeeId: personId, quantity: 20, unit: 'day', rate: 8000 }],
      }).expect(201);
    });
    then('the bill is a draft numbered "VB-00001"', () => {
      expect(res.body.data).toMatchObject({ status: 'draft', billNumber: 'VB-00001', vendorName: 'Acme Contractors', currency: 'INR' });
    });
    and('the bill totals 160000 plus 28800 tax, 188800 in all', () => {
      expect(res.body.data).toMatchObject({ subtotal: 160000, taxAmount: 28800, total: 188800 });
      expect(res.body.data.lineItems[0]).toMatchObject({ amount: 160000, contractorName: 'Amit Sharma' });
    });
  });

  test('the client cannot dictate what a line costs', ({ given, when, then, and }) => {
    given('an organization with a vendor "Acme Contractors" supplying "Amit Sharma"', givenVendorWithPerson);
    when('the owner raises a bill whose line also states its own amount', async () => {
      // `amount` is not part of the DTO, so the API rejects it outright rather
      // than quietly ignoring it — the money is the server's to work out.
      res = await raiseBill(org, vendorId, {
        lineItems: [{ description: 'Amit — Aug', quantity: 20, unit: 'day', rate: 8000, amount: 1 }],
      });
    });
    then('the request is rejected as an unknown field', () => {
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/amount/);
    });
    and('raising the same bill without it stores quantity times rate', async () => {
      const ok = await raiseBill(org, vendorId, {
        lineItems: [{ description: 'Amit — Aug', quantity: 20, unit: 'day', rate: 8000 }],
      }).expect(201);
      expect(ok.body.data.lineItems[0].amount).toBe(160000);
      expect(ok.body.data.total).toBe(160000);
    });
  });

  test('a bill cannot charge for someone the vendor does not supply', ({ given, when, then }) => {
    let otherPersonId: string;

    given('an organization with two vendors, each supplying one person', async () => {
      await givenVendorWithPerson();
      const otherVendorId = await addVendor(org, 'Nova Partners');
      otherPersonId = await addPerson(org, otherVendorId, 'Priya Rao');
    });
    when("the owner bills the first vendor for the second vendor's person", async () => {
      res = await raiseBill(org, vendorId, {
        lineItems: [{ description: 'Priya — Aug', vendorEmployeeId: otherPersonId, quantity: 5, rate: 1000 }],
      });
    });
    then('the request is rejected', () => {
      expect(res.status).toBe(400);
    });
  });

  test('approving then paying a bill', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors" supplying "Amit Sharma"', givenVendorWithPerson);
    and('a draft bill for that vendor', givenDraftBill);
    when('the owner approves the bill', async () => {
      res = await as(org.ownerToken).post(`/vendors/bills/${billId}/approve`).expect(201);
    });
    then('the bill records who approved it', () => {
      expect(res.body.data).toMatchObject({ status: 'approved', approvedBy: org.ownerId });
      expect(res.body.data.approvedAt).toBeTruthy();
    });
    and('it cannot be edited any more', async () => {
      const edit = await as(org.ownerToken).patch(`/vendors/bills/${billId}`, { period: 'Sep 2026' });
      expect(edit.status).toBe(400);
    });
    when('the owner marks it paid with reference "UTR-99"', async () => {
      res = await as(org.ownerToken).post(`/vendors/bills/${billId}/mark-paid`, { paymentReference: 'UTR-99' }).expect(201);
    });
    then('the bill is paid, with that reference', () => {
      expect(res.body.data).toMatchObject({ status: 'paid', paymentReference: 'UTR-99', paidBy: org.ownerId });
    });
  });

  test('a bill must be approved before it can be paid', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors" supplying "Amit Sharma"', givenVendorWithPerson);
    and('a draft bill for that vendor', givenDraftBill);
    when('the owner tries to mark the draft paid', async () => {
      res = await as(org.ownerToken).post(`/vendors/bills/${billId}/mark-paid`, {});
    });
    then('the request is rejected', () => {
      expect(res.status).toBe(400);
    });
  });

  test('cancelling a bill we will not pay', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors" supplying "Amit Sharma"', givenVendorWithPerson);
    and('a draft bill for that vendor', givenDraftBill);
    when('the owner cancels it as "Duplicate"', async () => {
      res = await as(org.ownerToken).post(`/vendors/bills/${billId}/cancel`, { reason: 'Duplicate' }).expect(201);
    });
    then('the bill is cancelled with that reason', () => {
      expect(res.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Duplicate' });
    });
    and('it no longer counts towards what the vendor has cost us', async () => {
      const summary = await as(org.ownerToken).get(`/vendors/${vendorId}/cost-summary`).expect(200);
      expect(summary.body.data).toMatchObject({ bills: 0, draft: 0, approved: 0, paid: 0, lifetime: 0 });
    });
  });

  test('the cost summary separates what we owe from what we have paid', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors" supplying "Amit Sharma"', givenVendorWithPerson);
    and('an approved bill of 10000 and a paid bill of 5000', async () => {
      const first = await raiseBill(org, vendorId, { lineItems: [{ description: 'Aug', quantity: 1, unit: 'fixed', rate: 10000 }] }).expect(201);
      await as(org.ownerToken).post(`/vendors/bills/${first.body.data.id}/approve`).expect(201);

      const second = await raiseBill(org, vendorId, { lineItems: [{ description: 'Jul', quantity: 1, unit: 'fixed', rate: 5000 }] }).expect(201);
      await as(org.ownerToken).post(`/vendors/bills/${second.body.data.id}/approve`).expect(201);
      await as(org.ownerToken).post(`/vendors/bills/${second.body.data.id}/mark-paid`, { paymentReference: 'UTR-1' }).expect(201);
    });
    when('the owner asks what that vendor has cost', async () => {
      res = await as(org.ownerToken).get(`/vendors/${vendorId}/cost-summary`).expect(200);
    });
    then('10000 is outstanding and 5000 is paid', () => {
      expect(res.body.data).toMatchObject({ outstanding: 10000, paid: 5000, committed: 15000, bills: 2 });
    });
  });

  test('a member with only vendors:view cannot raise or approve bills', ({ given, when, then, but }) => {
    let viewer: string;

    given('an organization with a vendor and a member whose role grants "vendors:view"', async () => {
      await givenVendorWithPerson();
      await givenDraftBill();
      const role = await as(org.ownerToken)
        .post('/org/roles', { name: `vendor-viewer-${Date.now()}`, displayName: 'Vendor viewer', permissions: [{ resource: 'vendors', actions: ['view'] }] })
        .expect(201);
      const email = randomEmail('billviewer');
      const added = await as(org.ownerToken)
        .post('/org/members', { email, roleId: role.body.data.id, firstName: 'Vera', lastName: 'Viewer' })
        .expect(201);
      h.trackUser(added.body.data.userId);
      viewer = await h.mintToken(email);
    });
    when('that member lists the bills', async () => {
      res = await as(viewer).get('/vendors/bills').expect(200);
    });
    then('the list is returned', () => {
      expect(res.body.data).toHaveLength(1);
    });
    but('raising a bill is rejected as forbidden', async () => {
      const denied = await as(viewer).post(`/vendors/${vendorId}/bills`, { lineItems: [{ description: 'x', quantity: 1, rate: 1 }] });
      expect(denied.status).toBe(403);
      const approve = await as(viewer).post(`/vendors/bills/${billId}/approve`);
      expect(approve.status).toBe(403);
    });
  });

  test('bills never cross organizations', ({ given, when, then }) => {
    given('two organizations each with a bill', async () => {
      await givenVendorWithPerson();
      await givenDraftBill();

      const second = await newOrg();
      const otherVendor = await addVendor(second, 'Their Vendor');
      await as(second.ownerToken).post(`/vendors/${otherVendor}/bills`, { lineItems: [{ description: 'Theirs', quantity: 1, rate: 100 }] }).expect(201);
    });
    when('the first owner lists the bills', async () => {
      res = await as(org.ownerToken).get('/vendors/bills').expect(200);
    });
    then("only the first organization's bill is listed", () => {
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].vendorName).toBe('Acme Contractors');
    });
  });
});
