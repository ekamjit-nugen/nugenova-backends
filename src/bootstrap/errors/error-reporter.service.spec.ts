import { ErrorReporterService, type ReportedError } from './error-reporter.service';

/**
 * Unit specs for the reporter — activity + mail are mocked. Pins what gets
 * filed, who is emailed, and the throttle that keeps a repeating fault from
 * flooding an inbox.
 */
describe('ErrorReporterService', () => {
  let service: ErrorReporterService;
  let activity: { record: jest.Mock };
  let mail: { send: jest.Mock };
  let config: { get: jest.Mock };
  let orgs: any;
  let memberships: any;
  let users: any;
  let env: Record<string, string>;

  const err = (over: Partial<ReportedError> = {}): ReportedError => ({
    reference: 'abc12345',
    status: 500,
    method: 'POST',
    path: '/api/v1/leaves',
    message: 'boom',
    stack: 'Error: boom\n    at handler (leave.service.ts:12:5)',
    organizationId: 'org1',
    userId: 'u1',
    userEmail: 'bob@acme.test',
    ip: '10.0.0.4',
    at: new Date('2026-09-16T10:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    env = { ERROR_ALERT_EMAIL: 'ops@nugeninfo.com' };
    activity = { record: jest.fn().mockResolvedValue(undefined) };
    mail = { send: jest.fn().mockResolvedValue(true) };
    config = { get: jest.fn((k: string) => env[k]) };
    orgs = { findOne: jest.fn().mockResolvedValue({ id: 'org1', ownerId: 'owner1' }) };
    memberships = { findOne: jest.fn().mockResolvedValue(null) };
    users = { findOne: jest.fn().mockResolvedValue({ id: 'owner1', email: 'owner@acme.test' }) };
    service = new ErrorReporterService(
      activity as any, mail as any, config as any, orgs, memberships, users,
    );
  });

  const recorded = () => activity.record.mock.calls.at(-1)![0];
  const sent = () => mail.send.mock.calls.at(-1)![0];

  describe('activity', () => {
    it('files a 500 under the errors category with the stack attached', async () => {
      await service.report(err());
      expect(recorded()).toEqual(
        expect.objectContaining({
          organizationId: 'org1',
          actorId: 'u1',
          action: 'error.server',
          category: 'errors',
          summary: '500 on POST /api/v1/leaves — boom',
          ip: '10.0.0.4',
        }),
      );
      expect(recorded().metadata.stack).toContain('leave.service.ts');
      expect(recorded().metadata.reference).toBe('abc12345');
    });

    it('files a 4xx as a client error and does not email', async () => {
      await service.report(err({ status: 403, message: 'Forbidden', stack: undefined }));
      expect(recorded().action).toBe('error.client');
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('keeps a 4xx stack out of the activity row', async () => {
      await service.report(err({ status: 400 }));
      expect(recorded().metadata.stack).toBeUndefined();
    });

    it('skips the org-scoped feed for an anonymous failure but still emails', async () => {
      await service.report(err({ organizationId: null, userId: null }));
      expect(activity.record).not.toHaveBeenCalled();
      expect(mail.send).toHaveBeenCalled();
      expect(sent().to).toEqual([{ email: 'ops@nugeninfo.com' }]);
    });
  });

  describe('recipients', () => {
    it('emails the ops address and the org owner', async () => {
      await service.report(err());
      expect(sent().to).toEqual([{ email: 'ops@nugeninfo.com' }, { email: 'owner@acme.test' }]);
    });

    it('accepts a comma-separated ops list and de-duplicates', async () => {
      env.ERROR_ALERT_EMAIL = 'ops@nugeninfo.com, Owner@acme.test ,';
      await service.report(err());
      expect(sent().to).toEqual([{ email: 'ops@nugeninfo.com' }, { email: 'owner@acme.test' }]);
    });

    it('falls back to the owner membership when the org has no ownerId', async () => {
      orgs.findOne.mockResolvedValue({ id: 'org1', ownerId: null });
      memberships.findOne.mockResolvedValue({ userId: 'owner2', email: null });
      users.findOne.mockResolvedValue({ id: 'owner2', email: 'boss@acme.test' });
      await service.report(err());
      expect(sent().to).toContainEqual({ email: 'boss@acme.test' });
    });

    it('still emails ops when the owner lookup throws', async () => {
      orgs.findOne.mockRejectedValue(new Error('db down'));
      await service.report(err());
      expect(sent().to).toEqual([{ email: 'ops@nugeninfo.com' }]);
    });

    it('sends nothing when no recipient is configured', async () => {
      env = {};
      orgs.findOne.mockResolvedValue(null);
      memberships.findOne.mockResolvedValue(null);
      await service.report(err());
      expect(mail.send).not.toHaveBeenCalled();
    });
  });

  describe('throttle', () => {
    it('sends once for a repeating fault', async () => {
      await service.report(err());
      await service.report(err({ reference: 'def67890' }));
      await service.report(err({ reference: 'ghi11111' }));
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('treats a different route as a different fault', async () => {
      await service.report(err());
      await service.report(err({ path: '/api/v1/payroll' }));
      expect(mail.send).toHaveBeenCalledTimes(2);
    });

    it('sends again once the window has passed', async () => {
      env.ERROR_ALERT_THROTTLE_MIN = '15';
      await service.report(err());
      const later = Date.now() + 16 * 60_000;
      jest.spyOn(Date, 'now').mockReturnValue(later);
      await service.report(err());
      expect(mail.send).toHaveBeenCalledTimes(2);
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('honours a throttle of zero (every fault alerts)', async () => {
      env.ERROR_ALERT_THROTTLE_MIN = '0';
      await service.report(err());
      await service.report(err());
      expect(mail.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('the email itself', () => {
    it('carries the reference, request and stack', async () => {
      await service.report(err());
      expect(sent().subject).toBe('[Nugenova] 500 on POST /api/v1/leaves (abc12345)');
      expect(sent().html).toContain('abc12345');
      expect(sent().html).toContain('/api/v1/leaves');
      expect(sent().html).toContain('leave.service.ts');
      expect(sent().category).toBe('error-alert');
    });

    it('escapes markup in the message so the mail cannot be injected', async () => {
      await service.report(err({ message: '<img src=x onerror="alert(1)">', stack: undefined }));
      expect(sent().html).not.toContain('<img');
      expect(sent().html).toContain('&lt;img');
    });

    it('never throws when the mailer fails', async () => {
      mail.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.report(err())).resolves.toBeUndefined();
    });
  });
});
