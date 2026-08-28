import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { WfhRequestEntity } from '../entities/wfh-request.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { NotifierService } from '../../notification/notifier.service';

export interface WfhRequestView {
  id: string;
  userId: string;
  employeeName: string | null;
  employeeEmail: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/** A calendar day at UTC midnight — how request date bounds are stored/compared. */
function toUtcDay(input: string | Date): Date {
  const s = typeof input === 'string' ? input : input.toISOString();
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}

/**
 * WfhRequestService — the work-from-home request/approval flow. WFH is no longer
 * self-declared: an employee requests a date range, an owner/HR approves it, and
 * `hasApprovedForDay` gates whether a clock-in that day counts as WFH (skipping
 * the office geo-fence). Org-scoped throughout.
 */
@Injectable()
export class WfhRequestService {
  private readonly logger = new Logger(WfhRequestService.name);

  constructor(
    @InjectRepository(WfhRequestEntity)
    private readonly repo: Repository<WfhRequestEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly notifier: NotifierService,
  ) {}

  /** dd Mon format for notification bodies, e.g. "02 Sep". */
  private static prettyDay(iso: string): string {
    const d = new Date(`${iso}T00:00:00.000Z`);
    return isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          timeZone: 'UTC',
        });
  }

  private static rangeLabel(start: string, end: string): string {
    return start === end
      ? WfhRequestService.prettyDay(start)
      : `${WfhRequestService.prettyDay(start)} – ${WfhRequestService.prettyDay(end)}`;
  }

  private async identity(orgId: string, userId: string): Promise<{ name: string | null; email: string | null }> {
    const u = await this.users.findOne({ where: { id: userId } });
    if (u) {
      return { name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email, email: u.email };
    }
    const m = await this.memberships.findOne({ where: { organizationId: orgId, userId } });
    return { name: m?.email ?? null, email: m?.email ?? null };
  }

  async create(
    orgId: string,
    userId: string,
    dto: { startDate: string; endDate?: string; reason?: string },
  ): Promise<WfhRequestView> {
    const start = toUtcDay(dto.startDate);
    const end = dto.endDate ? toUtcDay(dto.endDate) : start;
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid dates');
    }
    if (end < start) {
      throw new BadRequestException('The end date cannot be before the start date');
    }
    const todayUtc = toUtcDay(new Date());
    if (end < todayUtc) {
      throw new BadRequestException('You cannot request work-from-home for past dates');
    }

    // Block a request that overlaps an existing pending/approved one for the user.
    const overlap = await this.repo.findOne({
      where: {
        organizationId: orgId,
        userId,
        isDeleted: false,
        status: 'pending' as any, // widened below via two-status check
        startDate: LessThanOrEqual(end),
        endDate: MoreThanOrEqual(start),
      },
    });
    const overlapApproved = await this.repo.findOne({
      where: {
        organizationId: orgId,
        userId,
        isDeleted: false,
        status: 'approved' as any,
        startDate: LessThanOrEqual(end),
        endDate: MoreThanOrEqual(start),
      },
    });
    if (overlap || overlapApproved) {
      throw new BadRequestException('You already have a WFH request covering those dates');
    }

    const who = await this.identity(orgId, userId);
    const saved = await this.repo.save(
      this.repo.create({
        organizationId: orgId,
        userId,
        employeeName: who.name,
        employeeEmail: who.email,
        startDate: start,
        endDate: end,
        reason: dto.reason?.trim() || null,
        status: 'pending',
      }),
    );

    // Tell everyone who can review attendance that a request awaits them.
    const range = WfhRequestService.rangeLabel(
      saved.startDate.toISOString().slice(0, 10),
      saved.endDate.toISOString().slice(0, 10),
    );
    await this.notifier.notifyManagers({
      organizationId: orgId,
      actorId: userId,
      resource: 'attendance',
      action: 'edit',
      type: 'wfh_request_submitted',
      title: 'New work-from-home request',
      body: `${who.name || who.email || 'A team member'} requested WFH for ${range}.`,
      data: { actionUrl: '/attendance', wfhRequestId: saved.id, tab: 'wfh' },
    });

    return this.toView(saved);
  }

  async listMine(orgId: string, userId: string): Promise<WfhRequestView[]> {
    const rows = await this.repo.find({
      where: { organizationId: orgId, userId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.toView(r));
  }

  async listPending(orgId: string): Promise<WfhRequestView[]> {
    const rows = await this.repo.find({
      where: { organizationId: orgId, status: 'pending', isDeleted: false },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.toView(r));
  }

  async listAll(orgId: string): Promise<WfhRequestView[]> {
    const rows = await this.repo.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.toView(r));
  }

  async review(
    orgId: string,
    id: string,
    approved: boolean,
    reviewer: string,
    note?: string,
  ): Promise<WfhRequestView> {
    const r = await this.repo.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!r) throw new NotFoundException('WFH request not found');
    if (r.status !== 'pending') {
      throw new BadRequestException('This request has already been reviewed');
    }
    r.status = approved ? 'approved' : 'rejected';
    r.reviewedBy = reviewer;
    r.reviewNote = note?.trim() || null;
    r.reviewedAt = new Date();
    await this.repo.save(r);

    // Tell the requester the outcome.
    const range = WfhRequestService.rangeLabel(
      r.startDate.toISOString().slice(0, 10),
      r.endDate.toISOString().slice(0, 10),
    );
    await this.notifier.notify({
      organizationId: orgId,
      userId: r.userId,
      actorId: reviewer,
      type: 'wfh_request_reviewed',
      title: approved ? 'WFH request approved' : 'WFH request rejected',
      body: approved
        ? `Your work-from-home request for ${range} was approved.${r.reviewNote ? ` Note: ${r.reviewNote}` : ''}`
        : `Your work-from-home request for ${range} was rejected.${r.reviewNote ? ` Note: ${r.reviewNote}` : ''}`,
      data: { actionUrl: '/attendance', wfhRequestId: r.id, tab: 'wfh' },
      priority: 'high',
    });

    return this.toView(r);
  }

  /** Cancel a still-pending request (the requester). */
  async cancel(orgId: string, id: string, userId: string): Promise<void> {
    const r = await this.repo.findOne({ where: { id, organizationId: orgId, userId, isDeleted: false } });
    if (!r) throw new NotFoundException('WFH request not found');
    if (r.status !== 'pending') {
      throw new BadRequestException('Only a pending request can be cancelled');
    }
    r.isDeleted = true;
    await this.repo.save(r);
  }

  /**
   * Whether the employee has an APPROVED WFH request covering `dayKey`
   * (YYYY-MM-DD, computed by the caller in the org timezone). Drives the clock-in
   * WFH decision.
   */
  async hasApprovedForDay(orgId: string, userId: string, dayKey: string): Promise<boolean> {
    const target = toUtcDay(dayKey);
    const hit = await this.repo.findOne({
      where: {
        organizationId: orgId,
        userId,
        status: 'approved',
        isDeleted: false,
        startDate: LessThanOrEqual(target),
        endDate: MoreThanOrEqual(target),
      },
    });
    return !!hit;
  }

  private toView(r: WfhRequestEntity): WfhRequestView {
    return {
      id: r.id,
      userId: r.userId,
      employeeName: r.employeeName,
      employeeEmail: r.employeeEmail,
      startDate: r.startDate.toISOString().slice(0, 10),
      endDate: r.endDate.toISOString().slice(0, 10),
      reason: r.reason,
      status: r.status,
      reviewedBy: r.reviewedBy,
      reviewNote: r.reviewNote,
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt,
    };
  }
}
