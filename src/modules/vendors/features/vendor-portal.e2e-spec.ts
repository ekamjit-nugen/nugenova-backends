import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness, randomEmail } from '../../organization/features/support/org-harness';
import { VendorEntity } from '../entities/vendor.entity';
import { VendorContactEntity } from '../entities/vendor-contact.entity';
import { VendorEmployeeEntity } from '../entities/vendor-employee.entity';
import { VendorAgreementEntity } from '../entities/vendor-agreement.entity';
import { VendorAgreementTemplateEntity } from '../entities/vendor-agreement-template.entity';
import { VendorBillEntity } from '../entities/vendor-bill.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

const feature = loadFeature('./vendor-portal.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let vendors: Repository<VendorEntity>;
  let contacts: Repository<VendorContactEntity>;
  let people: Repository<VendorEmployeeEntity>;
  let agreements: Repository<VendorAgreementEntity>;
  let templates: Repository<VendorAgreementTemplateEntity>;
  let bills: Repository<VendorBillEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    vendors = h.app.get(getRepositoryToken(VendorEntity));
    contacts = h.app.get(getRepositoryToken(VendorContactEntity));
    people = h.app.get(getRepositoryToken(VendorEmployeeEntity));
    agreements = h.app.get(getRepositoryToken(VendorAgreementEntity));
    templates = h.app.get(getRepositoryToken(VendorAgreementTemplateEntity));
    bills = h.app.get(getRepositoryToken(VendorBillEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      await bills.delete({ organizationId: In(oids) }).catch(() => undefined);
      await agreements.delete({ organizationId: In(oids) }).catch(() => undefined);
      await templates.delete({ organizationId: In(oids) }).catch(() => undefined);
      await people.delete({ organizationId: In(oids) }).catch(() => undefined);
      await contacts.delete({ organizationId: In(oids) }).catch(() => undefined);
      await vendors.delete({ organizationId: In(oids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const as = (token: string) => ({
    get: (path: string) => h.api().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => h.api().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object = {}) => h.api().patch(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    del: (path: string) => h.api().delete(`${API}${path}`).set('Authorization', `Bearer ${token}`),
  });

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  const addVendor = async (o: CreatedOrg, companyName = 'Acme Contractors'): Promise<string> =>
    (await as(o.ownerToken).post('/vendors', { companyName, serviceCategory: 'Staffing' }).expect(201)).body.data.id;

  const addContact = async (o: CreatedOrg, vendorId: string, email: string, name = 'Riya Verma'): Promise<string> =>
    (await as(o.ownerToken).post(`/vendors/${vendorId}/contacts`, { name, email, isPrimary: true }).expect(201)).body.data.id;

  /** A vendor contact with a portal login, and their token. */
  const invitePortalUser = async (o: CreatedOrg, vendorId: string) => {
    const email = randomEmail('vendorportal');
    const contactId = await addContact(o, vendorId, email);
    // The portal is closed until someone opens it for this vendor.
    await as(o.ownerToken).patch(`/vendors/${vendorId}/portal`, { enabled: true }).expect(200);
    const invited = await as(o.ownerToken).post(`/vendors/${vendorId}/contacts/${contactId}/invite`, {}).expect(201);
    h.trackUser(invited.body.data.userId);
    return { email, contactId, userId: invited.body.data.userId as string, token: await h.mintToken(email) };
  };

  const sendRequiredAgreement = async (o: CreatedOrg, vendorId: string): Promise<string> => {
    const created = await as(o.ownerToken)
      .post(`/vendors/${vendorId}/agreements`, { title: 'Master Services Agreement', bodyHtml: '<p>Terms.</p>', requiredForOnboarding: true })
      .expect(201);
    await as(o.ownerToken).post(`/vendors/${vendorId}/agreements/${created.body.data.id}/send`).expect(201);
    return created.body.data.id;
  };

  // Shared scenario state.
  let org: CreatedOrg;
  let vendorId: string;
  let portal: { email: string; contactId: string; userId: string; token: string };
  let agreementId: string;
  let res: request.Response;

  const givenVendorWithPortalUser = async () => {
    org = await newOrg();
    vendorId = await addVendor(org);
    portal = await invitePortalUser(org, vendorId);
  };

  test('the portal is closed until someone opens it', ({ given, when, then }) => {
    let firstContactId: string;
    let emails: string[];

    given('an organization with a vendor "Acme Contractors" and two contacts with emails', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
      emails = [randomEmail('vendorone'), randomEmail('vendortwo')];
      firstContactId = await addContact(org, vendorId, emails[0], 'Riya Verma');
      await addContact(org, vendorId, emails[1], 'Neha Shah');
    });
    when('the owner tries to invite a contact', async () => {
      res = await as(org.ownerToken).post(`/vendors/${vendorId}/contacts/${firstContactId}/invite`, {});
    });
    then('the invite is refused because the portal is off', () => {
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/Turn on portal access/);
    });
    when('the owner turns the portal on', async () => {
      res = await as(org.ownerToken).patch(`/vendors/${vendorId}/portal`, { enabled: true }).expect(200);
    });
    then('both contacts are invited and emailed', async () => {
      expect(res.body.data).toMatchObject({ portalEnabled: true, invited: 2, skipped: 0 });
      const users = await as(org.ownerToken).get(`/vendors/${vendorId}/portal-users`).expect(200);
      expect(users.body.data.map((u: { email: string }) => u.email).sort()).toEqual([...emails].sort());
      users.body.data.forEach((u: { userId: string }) => h.trackUser(u.userId));
    });
  });

  test('turning the portal off locks the vendor out without deleting their login', ({ given, when, then }) => {
    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    when('the owner turns the portal off', async () => {
      await as(org.ownerToken).patch(`/vendors/${vendorId}/portal`, { enabled: false }).expect(200);
    });
    then('the portal is closed to them', async () => {
      res = await as(portal.token).get('/vendor-portal/me');
      expect(res.status).toBe(403);
      // Their login is untouched — only the switch is off.
      const m = await memberships.findOne({ where: { organizationId: org.orgId, userId: portal.userId } });
      expect(m?.status).toBe('active');
    });
    when('the owner turns it back on', async () => {
      await as(org.ownerToken).patch(`/vendors/${vendorId}/portal`, { enabled: true }).expect(200);
    });
    then('they can use the portal again', async () => {
      const me = await as(portal.token).get('/vendor-portal/me').expect(200);
      expect(me.body.data.vendor.id).toBe(vendorId);
    });
  });

  test('inviting a contact gives them a vendor login, not a staff one', ({ given, when, then, and }) => {
    let email: string;
    let contactId: string;

    given('an organization with a vendor "Acme Contractors" and a contact with an email', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
      email = randomEmail('vendorcontact');
      contactId = await addContact(org, vendorId, email);
      await as(org.ownerToken).patch(`/vendors/${vendorId}/portal`, { enabled: true }).expect(200);
    });
    when('the owner invites that contact to the portal', async () => {
      res = await as(org.ownerToken).post(`/vendors/${vendorId}/contacts/${contactId}/invite`, {}).expect(201);
      h.trackUser(res.body.data.userId);
    });
    then('a vendor-role login exists for that email', async () => {
      const m = await memberships.findOne({ where: { organizationId: org.orgId, userId: res.body.data.userId } });
      expect(m).toMatchObject({ role: 'vendor', personType: 'vendor', vendorId, status: 'active' });
    });
    and('that login is not counted as staff', async () => {
      // personType keeps them out of every staff-scoped query — payroll, the
      // roster, headcount and the Directory.
      const staff = await memberships.find({ where: { organizationId: org.orgId, personType: 'staff' } });
      expect(staff.map((m) => m.userId)).not.toContain(res.body.data.userId);
    });
  });

  test('a staff member cannot be turned into a vendor login', ({ given, and, when, then }) => {
    let contactId: string;

    given('an organization with a vendor and an employee member', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
    });
    and("a vendor contact carrying that employee's email", async () => {
      const member = await h.createEmployeeMember(org);
      contactId = await addContact(org, vendorId, member.email, 'Staff Person');
      // Opening the portal skips the contact it can't invite rather than failing.
      const opened = await as(org.ownerToken).patch(`/vendors/${vendorId}/portal`, { enabled: true }).expect(200);
      expect(opened.body.data).toMatchObject({ portalEnabled: true, invited: 0, skipped: 1 });
    });
    when('the owner invites that contact to the portal', async () => {
      res = await as(org.ownerToken).post(`/vendors/${vendorId}/contacts/${contactId}/invite`, {});
    });
    then('the invite is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('the portal shows the vendor what we need and what we owe', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    and('a required agreement sent to that vendor', async () => {
      agreementId = await sendRequiredAgreement(org, vendorId);
    });
    and('an approved bill of 10000 for that vendor', async () => {
      const bill = await as(org.ownerToken)
        .post(`/vendors/${vendorId}/bills`, { lineItems: [{ description: 'Aug', quantity: 1, unit: 'fixed', rate: 10000 }] })
        .expect(201);
      await as(org.ownerToken).post(`/vendors/bills/${bill.body.data.id}/approve`).expect(201);
    });
    when('the portal user opens their portal', async () => {
      res = await as(portal.token).get('/vendor-portal/me').expect(200);
    });
    then('they see 1 agreement outstanding and 10000 awaiting payment', () => {
      expect(res.body.data.vendor).toMatchObject({ id: vendorId, companyName: 'Acme Contractors' });
      expect(res.body.data.clearance).toMatchObject({ cleared: false, outstanding: 1 });
      expect(res.body.data.awaitingPayment).toBe(10000);
    });
  });

  test('the vendor signs an agreement themselves', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    and('a required agreement sent to that vendor', async () => {
      agreementId = await sendRequiredAgreement(org, vendorId);
    });
    when('the portal user signs it as "Riya Verma"', async () => {
      res = await as(portal.token).post(`/vendor-portal/agreements/${agreementId}/sign`, { signerName: 'Riya Verma' }).expect(201);
    });
    then('the agreement is signed by them, typed rather than recorded on their behalf', () => {
      expect(res.body.data.status).toBe('signed');
      expect(res.body.data.signature).toMatchObject({ signerName: 'Riya Verma', method: 'typed', signedByUserId: portal.userId });
    });
    and('their portal shows nothing outstanding', async () => {
      const me = await as(portal.token).get('/vendor-portal/me').expect(200);
      expect(me.body.data.clearance).toMatchObject({ cleared: true, outstanding: 0 });
    });
  });

  test('our drafts are not the vendor\'s business', ({ given, and, when, then }) => {
    let draftAgreementId: string;

    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    and('a draft agreement and a draft bill for that vendor', async () => {
      const a = await as(org.ownerToken)
        .post(`/vendors/${vendorId}/agreements`, { title: 'Draft MSA', bodyHtml: '<p>Working copy.</p>' })
        .expect(201);
      draftAgreementId = a.body.data.id;
      await as(org.ownerToken).post(`/vendors/${vendorId}/bills`, { lineItems: [{ description: 'Draft', quantity: 1, rate: 500 }] }).expect(201);
    });
    when('the portal user lists their agreements and bills', async () => {
      res = await as(portal.token).get('/vendor-portal/agreements').expect(200);
    });
    then('both lists are empty', async () => {
      expect(res.body.data).toEqual([]);
      const billsRes = await as(portal.token).get('/vendor-portal/bills').expect(200);
      expect(billsRes.body.data).toEqual([]);
    });
    and('signing the draft agreement is rejected', async () => {
      const denied = await as(portal.token).post(`/vendor-portal/agreements/${draftAgreementId}/sign`, { signerName: 'Riya Verma' });
      expect(denied.status).toBe(404);
    });
  });

  test('the vendor keeps their own roster, but not their rates', ({ given, when, then, and }) => {
    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    when('the portal user adds "Amit Sharma" to their roster with a rate of 9999', async () => {
      res = await as(portal.token)
        .post('/vendor-portal/people', { name: 'Amit Sharma', designation: 'React Developer', rateAmount: 9999 })
        .expect(201);
    });
    then('the person is added with no rate', () => {
      expect(res.body.data).toMatchObject({ name: 'Amit Sharma', vendorId, rateAmount: null });
    });
    and('the rate stays ours to set', async () => {
      const edited = await as(portal.token).patch(`/vendor-portal/people/${res.body.data.id}`, { rateAmount: 12345 }).expect(200);
      expect(edited.body.data.rateAmount).toBeNull();

      const byUs = await as(org.ownerToken).patch(`/vendors/${vendorId}/employees/${res.body.data.id}`, { rateAmount: 8000 }).expect(200);
      expect(Number(byUs.body.data.rateAmount)).toBe(8000);
    });
  });

  test('a supplied contractor cannot use the vendor portal', ({ given, and, when, then }) => {
    let contractorToken: string;

    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    and('a contractor supplied by that vendor, made a secondary member', async () => {
      const email = randomEmail('contractor');
      const person = await as(org.ownerToken).post(`/vendors/${vendorId}/employees`, { name: 'Amit Sharma', email }).expect(201);
      const promoted = await as(org.ownerToken).post(`/vendors/${vendorId}/employees/${person.body.data.id}/promote`).expect(201);
      h.trackUser(promoted.body.data.userId);
      contractorToken = await h.mintToken(email);
    });
    when('that contractor tries to open the vendor portal', async () => {
      res = await as(contractorToken).get('/vendor-portal/me');
    });
    then('the portal is closed to them', () => {
      // The portal is the vendor's own office — a contractor we host would see
      // the vendor's bills and agreements there.
      expect(res.status).toBe(403);
    });
  });

  test('a portal user holds no staff access', ({ given, when, then, and }) => {
    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    when('the portal user tries to read the vendor list', async () => {
      res = await as(portal.token).get('/vendors');
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
    and('the team directory is closed to them too', async () => {
      const denied = await as(portal.token).get('/org/members');
      expect(denied.status).toBeGreaterThanOrEqual(400);
    });
  });

  test('a portal user reaches nothing of another vendor', ({ given, when, then }) => {
    given('an organization with two vendors, each with its own bill, and a portal user at the first', async () => {
      await givenVendorWithPortalUser();
      const raise = async (id: string, description: string) => {
        const bill = await as(org.ownerToken).post(`/vendors/${id}/bills`, { lineItems: [{ description, quantity: 1, rate: 100 }] }).expect(201);
        await as(org.ownerToken).post(`/vendors/bills/${bill.body.data.id}/approve`).expect(201);
      };
      await raise(vendorId, 'Ours');
      await raise(await addVendor(org, 'Nova Partners'), 'Theirs');
    });
    when('that portal user lists their bills', async () => {
      res = await as(portal.token).get('/vendor-portal/bills').expect(200);
    });
    then("only their own vendor's bill is listed", () => {
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].lineItems[0].description).toBe('Ours');
    });
  });

  test('revoking access closes the portal', ({ given, when, then, and }) => {
    given('an organization with a vendor "Acme Contractors" and a portal user', givenVendorWithPortalUser);
    when("the owner revokes that contact's portal access", async () => {
      await as(org.ownerToken).del(`/vendors/${vendorId}/contacts/${portal.contactId}/invite`).expect(200);
    });
    then('the portal is closed to them', async () => {
      // A token minted after revocation carries no vendor membership at all.
      const staleToken = await h.mintToken(portal.email).catch(() => null);
      if (staleToken) {
        res = await as(staleToken).get('/vendor-portal/me');
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
      const m = await memberships.findOne({ where: { organizationId: org.orgId, userId: portal.userId } });
      expect(m?.status).toBe('inactive');
    });
    and('the contact record is still there', async () => {
      const detail = await as(org.ownerToken).get(`/vendors/${vendorId}`).expect(200);
      const contact = detail.body.data.contacts.find((c: { id: string }) => c.id === portal.contactId);
      expect(contact).toMatchObject({ name: 'Riya Verma', userId: null });
    });
  });
});
