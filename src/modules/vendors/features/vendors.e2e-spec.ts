import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness, randomEmail } from '../../organization/features/support/org-harness';
import { VendorEntity } from '../entities/vendor.entity';
import { VendorContactEntity } from '../entities/vendor-contact.entity';
import { VendorEmployeeEntity } from '../entities/vendor-employee.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

const feature = loadFeature('./vendors.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let vendors: Repository<VendorEntity>;
  let contacts: Repository<VendorContactEntity>;
  let people: Repository<VendorEmployeeEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    vendors = h.app.get(getRepositoryToken(VendorEntity));
    contacts = h.app.get(getRepositoryToken(VendorContactEntity));
    people = h.app.get(getRepositoryToken(VendorEmployeeEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      await people.delete({ organizationId: In(oids) }).catch(() => undefined);
      await contacts.delete({ organizationId: In(oids) }).catch(() => undefined);
      await vendors.delete({ organizationId: In(oids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const as = (token: string) => ({
    get: (path: string) => h.api().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => h.api().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    del: (path: string) => h.api().delete(`${API}${path}`).set('Authorization', `Bearer ${token}`),
  });

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  const createVendor = (o: CreatedOrg, companyName: string) =>
    as(o.ownerToken).post('/vendors', { companyName, serviceCategory: 'Staffing' });

  /** A member whose custom role grants exactly `vendors:view`. */
  const createVendorViewer = async (o: CreatedOrg): Promise<string> => {
    const role = await as(o.ownerToken)
      .post('/org/roles', {
        name: `vendor-viewer-${Date.now()}`,
        displayName: 'Vendor viewer',
        permissions: [{ resource: 'vendors', actions: ['view'] }],
      })
      .expect(201);
    const email = randomEmail('vendorviewer');
    const added = await as(o.ownerToken)
      .post('/org/members', { email, roleId: role.body.data.id, firstName: 'Vera', lastName: 'Viewer' })
      .expect(201);
    h.trackUser(added.body.data.userId);
    return h.mintToken(email); // the token now carries the role's vendors grant
  };

  test('an admin adds a vendor', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization', async () => {
      org = await newOrg();
    });
    when('the owner creates a vendor "Acme Contractors"', async () => {
      res = await createVendor(org, 'Acme Contractors').expect(201);
    });
    then('the vendor is stored with status "active" and onboarding "invited"', () => {
      expect(res.body.data).toMatchObject({ companyName: 'Acme Contractors', status: 'active', onboardingStatus: 'invited' });
    });
    and("the vendor appears in the org's vendor list", async () => {
      const list = await as(org.ownerToken).get('/vendors').expect(200);
      expect(list.body.data.map((v: VendorEntity) => v.companyName)).toContain('Acme Contractors');
    });
  });

  test('duplicate company names are rejected', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      await createVendor(org, 'Acme Contractors').expect(201);
    });
    when('the owner creates a vendor "Acme Contractors" again', async () => {
      res = await createVendor(org, 'Acme Contractors');
    });
    then('the create is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('an employee without the vendors permission cannot see vendors', ({ given, when, then }) => {
    let member: { token: string };
    let res: request.Response;

    given('an organization with a vendor "Acme Contractors" and an employee member', async () => {
      const org = await newOrg();
      await createVendor(org, 'Acme Contractors').expect(201);
      member = await h.createEmployeeMember(org);
    });
    when('the employee asks for the vendor list', async () => {
      res = await as(member.token).get('/vendors');
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a role granted vendors:view can read but not change vendors', ({ given, when, then, but }) => {
    let viewer: string;
    let res: request.Response;

    given('an organization with a vendor "Acme Contractors" and a member whose role grants "vendors:view"', async () => {
      const org = await newOrg();
      await createVendor(org, 'Acme Contractors').expect(201);
      viewer = await createVendorViewer(org);
    });
    when('that member asks for the vendor list', async () => {
      res = await as(viewer).get('/vendors').expect(200);
    });
    then('the list includes "Acme Contractors"', () => {
      expect(res.body.data.map((v: VendorEntity) => v.companyName)).toContain('Acme Contractors');
    });
    but('creating a vendor is rejected as forbidden', async () => {
      const denied = await as(viewer).post('/vendors', { companyName: 'Sneaky Supplies' });
      expect(denied.status).toBe(403);
    });
  });

  test('an admin adds a contractor supplied by a vendor', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let vendorId: string;
    let res: request.Response;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = (await createVendor(org, 'Acme Contractors').expect(201)).body.data.id;
    });
    when('the owner adds the contractor "Amit Sharma" at 8000 per "day"', async () => {
      res = await as(org.ownerToken)
        .post(`/vendors/${vendorId}/employees`, {
          name: 'Amit Sharma',
          email: 'amit@acme.test',
          designation: 'React Developer',
          skills: ['React', 'Node'],
          rateAmount: 8000,
          rateUnit: 'day',
        })
        .expect(201);
    });
    then("the vendor's people list includes \"Amit Sharma\" with rate 8000 per \"day\"", async () => {
      const list = await as(org.ownerToken).get(`/vendors/${vendorId}/employees`).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ name: 'Amit Sharma', rateAmount: 8000, rateUnit: 'day' });
      expect(res.body.data.id).toBe(list.body.data[0].id);
    });
    and('the contractor is not a member of the organization', async () => {
      // The whole point of a separate table: a supplied contractor must never
      // land in org_memberships, where payroll and the roster would find them.
      const members = await memberships.find({ where: { organizationId: org.orgId } });
      expect(members.some((m) => m.personType !== 'staff')).toBe(false);
    });
  });

  test('a supplied contractor can be made a secondary member of the org', ({ given, and, when, then, but }) => {
    let org2: CreatedOrg;
    let vendorId2: string;
    let personId: string;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org2 = await newOrg();
      vendorId2 = (await createVendor(org2, 'Acme Contractors').expect(201)).body.data.id;
    });
    and('the contractor "Amit Sharma" with an email, supplied by that vendor', async () => {
      personId = (await as(org2.ownerToken)
        .post(`/vendors/${vendorId2}/employees`, { name: 'Amit Sharma', email: randomEmail('contractor') })
        .expect(201)).body.data.id;
    });
    when('the owner makes them a secondary member', async () => {
      const res = await as(org2.ownerToken).post(`/vendors/${vendorId2}/employees/${personId}/promote`).expect(201);
      expect(res.body.data.suppliedBy).toMatchObject({ vendorId: vendorId2, companyName: 'Acme Contractors' });
      h.trackUser(res.body.data.userId);
    });
    then('they appear in the directory badged as supplied by "Acme Contractors"', async () => {
      const dir = await as(org2.ownerToken).get('/org/members?includeSecondary=true').expect(200);
      const them = dir.body.data.find((m: { email: string | null }) => m.email?.startsWith('contractor+'));
      expect(them).toMatchObject({ personType: 'vendor' });
      expect(them.suppliedBy).toMatchObject({ companyName: 'Acme Contractors' });
    });
    but('the staff directory does not include them', async () => {
      // staffScope is what keeps them out of payroll, the roster and seat counts.
      const staff = await as(org2.ownerToken).get('/org/members').expect(200);
      expect(staff.body.data.some((m: { email: string | null }) => m.email?.startsWith('contractor+'))).toBe(false);
    });
    when('the owner takes them back out', async () => {
      await as(org2.ownerToken).del(`/vendors/${vendorId2}/employees/${personId}/promote`).expect(200);
    });
    then('they are gone from the directory again', async () => {
      const dir = await as(org2.ownerToken).get('/org/members?includeSecondary=true').expect(200);
      const them = dir.body.data.find((m: { email: string | null }) => m.email?.startsWith('contractor+'));
      expect(them?.status ?? 'inactive').toBe('inactive');
    });
    and('their record at the vendor is still there', async () => {
      const people = await as(org2.ownerToken).get(`/vendors/${vendorId2}/employees`).expect(200);
      expect(people.body.data.map((p: { name: string }) => p.name)).toContain('Amit Sharma');
    });
  });

  test('someone with no email cannot be a secondary member', ({ given, and, when, then }) => {
    let org3: CreatedOrg;
    let vendorId3: string;
    let personId: string;
    let res: request.Response;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org3 = await newOrg();
      vendorId3 = (await createVendor(org3, 'Acme Contractors').expect(201)).body.data.id;
    });
    and('the contractor "Amit Sharma" already supplied by that vendor', async () => {
      personId = (await as(org3.ownerToken).post(`/vendors/${vendorId3}/employees`, { name: 'Amit Sharma' }).expect(201)).body.data.id;
    });
    when('the owner makes them a secondary member', async () => {
      res = await as(org3.ownerToken).post(`/vendors/${vendorId3}/employees/${personId}/promote`);
    });
    then('the request is rejected, asking for an email', () => {
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/email/i);
    });
  });

  test('the same contractor cannot be added twice to one vendor', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let vendorId: string;
    let res: request.Response;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = (await createVendor(org, 'Acme Contractors').expect(201)).body.data.id;
    });
    and('the contractor "Amit Sharma" already supplied by that vendor', async () => {
      await as(org.ownerToken).post(`/vendors/${vendorId}/employees`, { name: 'Amit Sharma', email: 'amit@acme.test' }).expect(201);
    });
    when('the owner adds a contractor with the same email', async () => {
      res = await as(org.ownerToken).post(`/vendors/${vendorId}/employees`, { name: 'Amit S.', email: 'amit@acme.test' });
    });
    then('the create is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('one contact at a time is the primary', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let vendorId: string;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = (await createVendor(org, 'Acme Contractors').expect(201)).body.data.id;
    });
    and('a primary contact "Riya" at that vendor', async () => {
      await as(org.ownerToken).post(`/vendors/${vendorId}/contacts`, { name: 'Riya', isPrimary: true }).expect(201);
    });
    when('the owner adds another primary contact "Neha"', async () => {
      await as(org.ownerToken).post(`/vendors/${vendorId}/contacts`, { name: 'Neha', isPrimary: true }).expect(201);
    });
    then('only "Neha" is primary', async () => {
      const detail = await as(org.ownerToken).get(`/vendors/${vendorId}`).expect(200);
      const primaries = detail.body.data.contacts.filter((c: VendorContactEntity) => c.isPrimary);
      expect(primaries.map((c: VendorContactEntity) => c.name)).toEqual(['Neha']);
    });
  });

  test('deleting a vendor takes its contacts and people with it', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let vendorId: string;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = (await createVendor(org, 'Acme Contractors').expect(201)).body.data.id;
      await as(org.ownerToken).post(`/vendors/${vendorId}/contacts`, { name: 'Riya', isPrimary: true }).expect(201);
    });
    and('the contractor "Amit Sharma" already supplied by that vendor', async () => {
      await as(org.ownerToken).post(`/vendors/${vendorId}/employees`, { name: 'Amit Sharma', email: 'amit@acme.test' }).expect(201);
    });
    when('the owner deletes the vendor', async () => {
      await as(org.ownerToken).del(`/vendors/${vendorId}`).expect(200);
    });
    then('the vendor is gone from the list', async () => {
      const list = await as(org.ownerToken).get('/vendors').expect(200);
      expect(list.body.data).toHaveLength(0);
    });
    and('the contractor no longer appears anywhere', async () => {
      await as(org.ownerToken).get(`/vendors/${vendorId}/employees`).expect(404);
      const rows = await people.find({ where: { vendorId } });
      expect(rows.every((r) => r.isDeleted)).toBe(true);
    });
  });

  test('vendors of another organization are never visible', ({ given, when, then }) => {
    let first: CreatedOrg;
    let res: request.Response;

    given('two organizations each with a vendor', async () => {
      first = await newOrg();
      const second = await newOrg();
      await createVendor(first, 'Acme Contractors').expect(201);
      await createVendor(second, 'Other Partners').expect(201);
    });
    when('the first owner asks for the vendor list', async () => {
      res = await as(first.ownerToken).get('/vendors').expect(200);
    });
    then("only the first organization's vendor is listed", () => {
      expect(res.body.data.map((v: VendorEntity) => v.companyName)).toEqual(['Acme Contractors']);
    });
  });

  test('the stats header counts vendors and supplied people', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      const id = (await createVendor(org, 'Acme Contractors').expect(201)).body.data.id;
      (org as CreatedOrg & { vendorId?: string }).vendorId = id;
    });
    and('the contractor "Amit Sharma" already supplied by that vendor', async () => {
      const id = (org as CreatedOrg & { vendorId?: string }).vendorId;
      await as(org.ownerToken).post(`/vendors/${id}/employees`, { name: 'Amit Sharma', email: 'amit@acme.test' }).expect(201);
    });
    when('the owner asks for vendor stats', async () => {
      res = await as(org.ownerToken).get('/vendors/stats').expect(200);
    });
    then('the stats report 1 vendor and 1 supplied person', () => {
      expect(res.body.data).toMatchObject({ total: 1, active: 1, people: 1 });
    });
  });
});
