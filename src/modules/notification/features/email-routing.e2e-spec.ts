import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
  randomEmail,
} from '../../organization/features/support/org-harness';
import { EmailOutboxEntity } from '../../../bootstrap/mail/email-outbox.entity';
import { NotifierService } from '../notifier.service';

const feature = loadFeature('./email-routing.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let outbox: Repository<EmailOutboxEntity>;
  const sentTo = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    outbox = h.app.get(getRepositoryToken(EmailOutboxEntity));
  });
  afterAll(async () => {
    if (sentTo.size) await outbox.delete({ to: In([...sentTo]) }).catch(() => undefined);
    await h.cleanup();
  });

  const as = (token: string) => ({
    get: (path: string) => h.api().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    put: (path: string, body: object) => h.api().put(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    post: (path: string, body: object) => h.api().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
  });

  const orgWithRole = async (permissions: object[] = []): Promise<{ o: CreatedOrg; roleId: string }> => {
    const o = await h.createOrg();
    const role = await as(o.ownerToken)
      .post('/org/roles', { name: `hr-${Date.now()}`, displayName: 'HR', permissions })
      .expect(201);
    return { o, roleId: role.body.data.id };
  };

  const emailsFor = async (category: string, subject: string) =>
    (await outbox.find({ where: { category, subject } })).map((r) => r.to.toLowerCase());

  test('an owner sees every email with its default recipients', ({ given, when, then, and }) => {
    let ctx: { o: CreatedOrg; roleId: string };
    let res: request.Response;
    given('an organization with a custom role', async () => {
      ctx = await orgWithRole();
    });
    when('the owner opens the email notification settings', async () => {
      res = await as(ctx.o.ownerToken).get('/notifications/emails');
    });
    then("every email is listed with the organization's roles as its columns", async () => {
      expect(res.status).toBe(200);
      const { audiences, emails } = res.body.data;
      // Exactly the permission matrix's columns, in its order: no Owner / Admin /
      // "No custom role" columns that the permission matrix doesn't have.
      const roles = await as(ctx.o.ownerToken).get('/org/roles').expect(200);
      expect(audiences.map((a: any) => a.roleId)).toEqual(roles.body.data.map((r: any) => r.id));
      expect(audiences.map((a: any) => a.label)).toContain('HR');
      expect(emails.length).toBeGreaterThan(40);
    });
    and('no role is ticked for the daily attendance summary', () => {
      const digest = res.body.data.emails.find((e: any) => e.key === 'attendance.daily_digest');
      expect(digest.kind).toBe('team');
      // Including the role we just created and any roles the org was seeded with.
      expect(Object.keys(digest.routing)).toContain(`role:${ctx.roleId}`);
      expect(Object.keys(digest.routing).every((k) => k.startsWith('role:'))).toBe(true);
      expect(Object.values(digest.routing).every((on) => on === false)).toBe(true);
    });
  });

  test('an employee cannot see or change email settings', ({ given, when, then }) => {
    let employeeToken: string;
    let res: request.Response;
    given('an organization with a custom role', async () => {
      const { o } = await orgWithRole();
      employeeToken = (await h.createEmployeeMember(o)).token;
    });
    when('an employee opens the email notification settings', async () => {
      res = await as(employeeToken).get('/notifications/emails');
    });
    then('the request is forbidden', async () => {
      expect(res.status).toBe(403);
      expect((await as(employeeToken).put('/notifications/emails/attendance.daily_digest/routing', { audience: 'role:anything', enabled: true })).status).toBe(403);
    });
  });

  test('an owner previews an email exactly as it is sent', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('an organization with a custom role', async () => {
      ({ o } = await orgWithRole());
    });
    when('the owner previews the daily attendance summary', async () => {
      res = await as(o.ownerToken).get('/notifications/emails/attendance.daily_digest/preview');
    });
    then("the preview has a subject and the email body with the organization's name", async () => {
      expect(res.status).toBe(200);
      expect(res.body.data.subject).toMatch(/Attendance summary/);
      const org = await h.organizations.findOne({ where: { id: o.orgId } });
      expect(res.body.data.html).toContain(org!.name);
    });
  });

  test('an always-sent email cannot be switched off for a role', ({ given, when, then }) => {
    let ctx: { o: CreatedOrg; roleId: string };
    let res: request.Response;
    given('an organization with a custom role', async () => {
      ctx = await orgWithRole();
    });
    when('the owner tries to stop sign-in codes for the HR role', async () => {
      res = await as(ctx.o.ownerToken).put('/notifications/emails/otp/routing', { audience: `role:${ctx.roleId}`, enabled: false });
    });
    then('the change is refused', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a team email reaches a role only once it is ticked', ({ given, when, then, and }) => {
    let ctx: { o: CreatedOrg; roleId: string };
    let ownerEmail: string;
    let hrEmail: string;
    let employee: { userId: string };
    const send = (subject: string) =>
      h.app.get(NotifierService).notifyManagers({
        organizationId: ctx.o.orgId,
        actorId: employee.userId,
        resource: 'leaves',
        action: 'edit',
        type: 'leave_requested',
        title: subject,
        body: 'Priya requested Casual Leave (2 days).',
        data: { actionUrl: '/leaves' },
      });

    given('an organization with an HR role that can approve leave', async () => {
      ctx = await orgWithRole([{ resource: 'leaves', actions: ['view', 'edit'] }]);
      hrEmail = randomEmail('hr').toLowerCase();
      const added = await as(ctx.o.ownerToken)
        .post('/org/members', { email: hrEmail, roleId: ctx.roleId, firstName: 'Hema', lastName: 'R' })
        .expect(201);
      h.trackUser(added.body.data.userId);
      employee = await h.createEmployeeMember(ctx.o);
      ownerEmail = ctx.o.ownerEmail.toLowerCase();
      sentTo.add(hrEmail).add(ownerEmail);
    });
    when("an employee's leave request is sent out", async () => {
      await send(`Leave request to review ${ctx.o.orgId}-1`);
    });
    then('the owner is emailed but the HR member is not', async () => {
      const to = await emailsFor('notification', `Leave request to review ${ctx.o.orgId}-1`);
      expect(to).toContain(ownerEmail);
      // HR can approve leave (in-app they're notified), but their role isn't ticked for the email.
      expect(to).not.toContain(hrEmail);
    });
    when('the owner ticks the HR role for leave requests', async () => {
      await as(ctx.o.ownerToken)
        .put('/notifications/emails/leave_requested/routing', { audience: `role:${ctx.roleId}`, enabled: true })
        .expect(200);
    });
    and('another leave request is sent out', async () => {
      await send(`Leave request to review ${ctx.o.orgId}-2`);
    });
    then('the HR member is emailed too', async () => {
      const to = await emailsFor('notification', `Leave request to review ${ctx.o.orgId}-2`);
      expect(to).toEqual(expect.arrayContaining([ownerEmail, hrEmail]));
    });
  });
});
