import JSZip from 'jszip';
import { ActivityRetentionService } from './activity-retention.service';

/** Fluent query-builder mock whose execute() returns a configurable result. */
function makeQb(result: { affected: number }) {
  const o: any = {};
  ['insert', 'values', 'orIgnore', 'update', 'set', 'where', 'andWhere', 'into'].forEach((m) => (o[m] = jest.fn(() => o)));
  o.execute = jest.fn(() => Promise.resolve(result));
  return o;
}

describe('ActivityRetentionService (unit, no DB)', () => {
  let events: any, runs: any, orgs: any, memberships: any, users: any, mail: any;
  let claimResult: { affected: number };
  const NOW = new Date('2026-09-30T03:20:00.000Z');

  const oldRows = [
    { id: 'e1', organizationId: 'orgA', actorName: 'Emp', action: 'leave.applied', category: 'leave', createdAt: new Date('2026-09-01') },
    { id: 'e2', organizationId: 'orgA', actorName: 'Emp', action: 'ai.used', category: 'ai', createdAt: new Date('2026-09-02') },
  ];

  const build = () => new ActivityRetentionService(events, runs, orgs, memberships, users, mail);

  beforeEach(() => {
    claimResult = { affected: 1 };
    events = { find: jest.fn(() => Promise.resolve(oldRows)), delete: jest.fn(() => Promise.resolve({})) };
    runs = { createQueryBuilder: jest.fn(() => makeQb(claimResult)), update: jest.fn(() => Promise.resolve({})) };
    orgs = { findOne: jest.fn(() => Promise.resolve({ id: 'orgA', ownerId: 'owner1' })), find: jest.fn(() => Promise.resolve([{ id: 'orgA' }])) };
    memberships = { findOne: jest.fn(() => Promise.resolve(null)) };
    users = { findOne: jest.fn(() => Promise.resolve({ id: 'owner1', email: 'owner@x.com', firstName: 'Olive', lastName: 'Owner' })) };
    mail = { send: jest.fn(() => Promise.resolve(true)) };
  });

  it('archives old rows: emails the owner a valid zip, THEN deletes exactly those rows', async () => {
    const res = await build().runForOrg('orgA', NOW, false);

    expect(res).toMatchObject({ archived: 2, claimed: true, emailed: true });

    // Emailed the owner with a zip attachment.
    expect(mail.send).toHaveBeenCalledTimes(1);
    const opts = mail.send.mock.calls[0][0];
    expect(opts.to.email).toBe('owner@x.com');
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0].filename).toMatch(/\.zip$/);
    expect(opts.attachments[0].contentType).toBe('application/zip');

    // The zip is real and contains the CSV + JSON export.
    const zip = await JSZip.loadAsync(opts.attachments[0].content);
    const names = Object.keys(zip.files).sort();
    expect(names).toContain('activity-logs.csv');
    expect(names).toContain('activity-logs.json');
    expect(await zip.file('activity-logs.csv')!.async('string')).toContain('leave.applied');

    // Deleted exactly the archived ids, and recorded the run.
    expect(events.delete).toHaveBeenCalledWith({ id: expect.objectContaining({ _value: ['e1', 'e2'] }) });
    expect(runs.update).toHaveBeenCalledWith({ organizationId: 'orgA' }, expect.objectContaining({ lastRunAt: NOW, lockedAt: null, lastArchivedCount: 2 }));
  });

  it('does nothing when it cannot claim the lock (not due / already running)', async () => {
    claimResult = { affected: 0 };
    const res = await build().runForOrg('orgA', NOW, false);
    expect(res.claimed).toBe(false);
    expect(events.find).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('with no old rows: records the run and sends nothing', async () => {
    events.find.mockResolvedValueOnce([]);
    const res = await build().runForOrg('orgA', NOW, false);
    expect(res.archived).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
    expect(events.delete).not.toHaveBeenCalled();
    expect(runs.update).toHaveBeenCalledWith({ organizationId: 'orgA' }, expect.objectContaining({ lastRunAt: NOW }));
  });

  it('never deletes when the backup email cannot be delivered (no owner email)', async () => {
    users.findOne.mockResolvedValueOnce({ id: 'owner1', email: null });
    const res = await build().runForOrg('orgA', NOW, false);
    expect(res.emailed).toBe(false);
    expect(events.delete).not.toHaveBeenCalled(); // backup-before-delete guarantee
    // lock released, run NOT marked complete (so it retries next cycle)
    expect(runs.update).toHaveBeenCalledWith({ organizationId: 'orgA' }, { lockedAt: null });
  });

  it('runAll iterates active orgs', async () => {
    orgs.find.mockResolvedValueOnce([{ id: 'orgA' }, { id: 'orgB' }]);
    events.find.mockResolvedValue([]); // both empty → simple
    const total = await build().runAll(NOW);
    expect(orgs.find).toHaveBeenCalledWith({ where: { status: 'active' } });
    expect(total).toBe(0);
  });
});
