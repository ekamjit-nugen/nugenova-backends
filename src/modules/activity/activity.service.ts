import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { ActivityCategory, ActivityEventEntity } from './entities/activity-event.entity';
import { UserEntity } from '../auth/entities/user.entity';

export interface ActivityCaller {
  userId: string;
  isAdmin: boolean;
}

/** What a writer passes to {@link ActivityService.record}. */
export interface RecordActivityInput {
  organizationId: string;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  category: ActivityCategory;
  targetType?: string | null;
  targetId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface ActivityQuery {
  scope?: 'all' | 'me';
  actorId?: string;
  category?: ActivityCategory;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

const MAX_LIMIT = 100;

/**
 * The unified activity feed. `record()` is the single write choke point used by
 * every module (best-effort, never throws — activity logging must never break a
 * real request). Reads are org-scoped and visibility-gated: admins/owners see
 * the whole org; a member only ever sees their own activity.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @InjectRepository(ActivityEventEntity) private readonly events: Repository<ActivityEventEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
  ) {}

  /** Persist one activity event. Never throws — failures are logged and swallowed. */
  async record(input: RecordActivityInput): Promise<void> {
    try {
      if (!input.organizationId || !input.action) return;
      let actorName = input.actorName ?? null;
      if (!actorName && input.actorId) actorName = await this.resolveName(input.actorId);
      await this.events.save(
        this.events.create({
          organizationId: input.organizationId,
          actorId: input.actorId ?? null,
          actorName,
          action: input.action,
          category: input.category,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          summary: input.summary ?? null,
          metadata: input.metadata ?? {},
          ip: input.ip ?? null,
        }),
      );
    } catch (err) {
      this.logger.warn(`activity.record failed (${input.action}): ${(err as Error).message}`);
    }
  }

  private async resolveName(userId: string): Promise<string | null> {
    try {
      const u = await this.users.findOne({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } });
      if (!u) return null;
      return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || null;
    } catch {
      return null;
    }
  }

  async list(orgId: string, caller: ActivityCaller, q: ActivityQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || 25));

    // A non-admin can only ever read their own activity.
    const scopeMe = !caller.isAdmin || q.scope === 'me';
    const where: Record<string, unknown> = { organizationId: orgId };
    if (scopeMe) where.actorId = caller.userId;
    else if (q.actorId) where.actorId = q.actorId;
    if (q.category) where.category = q.category;

    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    if (from && to) where.createdAt = Between(from, to);
    else if (from) where.createdAt = MoreThanOrEqual(from);
    else if (to) where.createdAt = LessThanOrEqual(to);

    const [items, total] = await this.events.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, page, limit, total };
  }
}
