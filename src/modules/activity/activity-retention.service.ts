import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import JSZip from 'jszip';

import { ActivityEventEntity } from './entities/activity-event.entity';
import { ActivityRetentionRunEntity } from './entities/activity-retention-run.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { NotifierService } from '../notification/notifier.service';
import { MailService } from '../../bootstrap/mail/mail.service';
import { newObjectId } from '../../bootstrap/database/object-id';
import { activityBackupEmail } from '../../bootstrap/mail/email-layout';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = 15;
const LOCK_STALE_MS = 60 * 60 * 1000; // a lock older than 1h is considered abandoned
const MAX_ARCHIVE_ROWS = 100_000; // safety cap per run

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Retention for the activity log: every {@link RETENTION_DAYS} days, per org,
 * archive activity rows older than the window into a zip (CSV + JSON), email it
 * to the org owner, then delete those rows. AI-usage metrics are never touched.
 *
 * A per-org lock row ({@link ActivityRetentionRunEntity}) enforces both the
 * 15-day cadence and single-run safety across instances (claimed with a
 * conditional UPDATE). Rows are deleted ONLY after the email is accepted, and
 * only the exact ids that were archived — never rows created during the run.
 */
@Injectable()
export class ActivityRetentionService {
  private readonly logger = new Logger(ActivityRetentionService.name);

  constructor(
    @InjectRepository(ActivityEventEntity) private readonly events: Repository<ActivityEventEntity>,
    @InjectRepository(ActivityRetentionRunEntity) private readonly runs: Repository<ActivityRetentionRunEntity>,
    @InjectRepository(OrganizationEntity) private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly mail: MailService,
    @Optional() private readonly notifier?: NotifierService,
  ) {}

  /** The org owner's user — via organizations.ownerId, falling back to the owner membership. */
  private async ownerUser(orgId: string): Promise<UserEntity | null> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    if (org?.ownerId) {
      const u = await this.users.findOne({ where: { id: org.ownerId } });
      if (u?.email) return u;
    }
    const m = await this.memberships.findOne({ where: { organizationId: orgId, role: 'owner', status: 'active' } });
    if (m?.userId) return this.users.findOne({ where: { id: m.userId } });
    return null;
  }

  /** Run retention for every active org. Returns total rows archived. */
  async runAll(now = new Date()): Promise<number> {
    const orgs = await this.orgs.find({ where: { status: 'active' } });
    let total = 0;
    for (const org of orgs) {
      try {
        const res = await this.runForOrg(org.id, now);
        total += res.archived;
      } catch (err) {
        this.logger.error(`retention failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
    return total;
  }

  /**
   * Archive+purge one org's old activity if it is due and can be claimed.
   * `force` skips the 15-day cadence check (used by the manual admin trigger).
   */
  async runForOrg(orgId: string, now = new Date(), force = false): Promise<{ archived: number; claimed: boolean; emailed: boolean }> {
    if (!(await this.claim(orgId, now, force))) return { archived: 0, claimed: false, emailed: false };

    try {
      const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
      const rows = await this.events.find({
        where: { organizationId: orgId, createdAt: LessThan(cutoff) },
        order: { createdAt: 'ASC' },
        take: MAX_ARCHIVE_ROWS,
      });
      if (!rows.length) {
        await this.finish(orgId, now, 0);
        return { archived: 0, claimed: true, emailed: false };
      }

      const zip = await this.buildZip(orgId, rows, cutoff);
      const emailed = await this.emailOwner(orgId, zip, rows.length, cutoff);
      if (!emailed) {
        // Never delete without a delivered backup — release the lock and retry next cycle.
        await this.release(orgId);
        this.logger.warn(`retention: no backup delivered for org ${orgId}; kept ${rows.length} rows`);
        return { archived: 0, claimed: true, emailed: false };
      }

      await this.events.delete({ id: In(rows.map((r) => r.id)) });
      await this.finish(orgId, now, rows.length);
      this.logger.log(`retention: archived+purged ${rows.length} activity rows for org ${orgId}`);
      return { archived: rows.length, claimed: true, emailed: true };
    } catch (err) {
      await this.release(orgId);
      throw err;
    }
  }

  // ── lock / cadence ─────────────────────────────────────────────────────────

  private async claim(orgId: string, now: Date, force: boolean): Promise<boolean> {
    // Ensure a marker row exists (id set explicitly — QueryBuilder skips @BeforeInsert).
    await this.runs
      .createQueryBuilder()
      .insert()
      .values({ id: newObjectId(), organizationId: orgId, lastRunAt: null, lockedAt: null, lastArchivedCount: 0 })
      .orIgnore()
      .execute();

    const qb = this.runs
      .createQueryBuilder()
      .update(ActivityRetentionRunEntity)
      .set({ lockedAt: now })
      .where('organization_id = :orgId', { orgId })
      .andWhere('(locked_at IS NULL OR locked_at < :lockStale)', { lockStale: new Date(now.getTime() - LOCK_STALE_MS) });
    if (!force) qb.andWhere('(last_run_at IS NULL OR last_run_at < :due)', { due: new Date(now.getTime() - RETENTION_DAYS * DAY_MS) });

    const res = await qb.execute();
    return (res.affected ?? 0) > 0;
  }

  private async finish(orgId: string, now: Date, archived: number): Promise<void> {
    await this.runs.update({ organizationId: orgId }, { lastRunAt: now, lockedAt: null, lastArchivedCount: archived });
  }

  private async release(orgId: string): Promise<void> {
    await this.runs.update({ organizationId: orgId }, { lockedAt: null });
  }

  // ── archive + email ─────────────────────────────────────────────────────────

  private async buildZip(orgId: string, rows: ActivityEventEntity[], cutoff: Date): Promise<Buffer> {
    const header = ['createdAt', 'actorName', 'actorId', 'action', 'category', 'targetType', 'targetId', 'summary', 'ip', 'metadata'];
    const csv = [
      header.join(','),
      ...rows.map((r) =>
        [r.createdAt?.toISOString?.() ?? r.createdAt, r.actorName, r.actorId, r.action, r.category, r.targetType, r.targetId, r.summary, r.ip, r.metadata]
          .map(csvCell)
          .join(','),
      ),
    ].join('\n');

    const zip = new JSZip();
    zip.file('activity-logs.csv', csv);
    zip.file('activity-logs.json', JSON.stringify(rows, null, 2));
    zip.file(
      'README.txt',
      `Nugenova activity-log archive\nOrganization: ${orgId}\nRows: ${rows.length}\nWindow: up to ${cutoff.toISOString()} (older than ${RETENTION_DAYS} days)\nGenerated: ${new Date().toISOString()}\n\nThese rows have been removed from the live activity log after this backup.\n`,
    );
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  private async emailOwner(orgId: string, zip: Buffer, count: number, cutoff: Date): Promise<boolean> {
    const owner = await this.ownerUser(orgId);
    if (!owner?.email) {
      this.logger.warn(`retention: org ${orgId} has no owner email; cannot deliver backup`);
      return false;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `activity-logs-${orgId}-${stamp}.zip`;
    // In-app copy (and real-time push) so the owner sees it in Notifications too;
    // the zip itself only goes by email.
    await this.notifier?.notify({
      organizationId: orgId,
      userId: owner.id,
      type: 'activity_backup_ready',
      title: `Activity log backup — ${count} entries archived`,
      body: `Entries older than ${RETENTION_DAYS} days were archived and emailed to you as a zip.`,
      data: { actionUrl: '/activity' },
      email: false, // the email with the attachment is sent below
    }).catch(() => undefined);
    const built = activityBackupEmail({ count, retentionDays: RETENTION_DAYS, cutoffLabel: cutoff.toISOString().slice(0, 10) });
    return this.mail.send({
      to: { email: owner.email, name: `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim() || undefined },
      subject: built.subject,
      html: built.html,
      text: built.text,
      attachments: [{ filename, content: zip, contentType: 'application/zip' }],
      category: 'activity.retention_backup',
      organizationId: orgId,
    });
  }
}
