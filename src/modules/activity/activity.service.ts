import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ActivityCategory, ActivityEventEntity } from './entities/activity-event.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { ERROR_AREAS, areaKeyOf, isErrorArea } from './error-areas';

/**
 * An error row's area: the stored `metadata.area`, or — for rows written before
 * areas existed — the first segment of its API path (`/api/v1/<segment>/...`).
 */
const AREA_SQL = `COALESCE(e.metadata->>'area', split_part(split_part(e.metadata->>'path', '?', 1), '/', 4))`;

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
  /** Errors only: the part of the app they came from (see error-areas). */
  area?: string;
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

    const qb = this.scoped(orgId, caller, q);
    if (q.category) qb.andWhere('e.category = :category', { category: q.category });
    if (q.area) {
      // An area only means something for errors.
      qb.andWhere('e.category = :errors', { errors: 'errors' });
      if (!isErrorArea(q.area)) throw new BadRequestException(`Unknown error area "${q.area}"`);
      if (q.area === 'other') {
        const known = ERROR_AREAS.flatMap((a) => (a.key === 'other' ? [] : [a.key, ...a.segments]));
        qb.andWhere(`${AREA_SQL} NOT IN (:...known)`, { known });
      } else {
        const area = ERROR_AREAS.find((a) => a.key === q.area)!;
        qb.andWhere(`${AREA_SQL} IN (:...keys)`, { keys: [area.key, ...area.segments] });
      }
    }

    const [items, total] = await qb
      .orderBy('e.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items, page, limit, total };
  }

  /**
   * How many errors each area has, for the Activity page's area filter. Same
   * visibility rules as the feed (a non-admin counts only their own errors).
   */
  async errorAreas(orgId: string, caller: ActivityCaller, q: Pick<ActivityQuery, 'scope' | 'actorId' | 'from' | 'to'>) {
    const rows = await this.scoped(orgId, caller, q)
      .andWhere('e.category = :errors', { errors: 'errors' })
      .select(AREA_SQL, 'segment')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('segment')
      .getRawMany<{ segment: string | null; count: number }>();
    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = areaKeyOf(r.segment);
      counts.set(key, (counts.get(key) ?? 0) + Number(r.count));
    }
    return ERROR_AREAS.filter((a) => counts.has(a.key)).map((a) => ({ key: a.key, label: a.label, count: counts.get(a.key)! }));
  }

  /** Org + who-can-see-what + date window, shared by the feed and the area counts. */
  private scoped(orgId: string, caller: ActivityCaller, q: Pick<ActivityQuery, 'scope' | 'actorId' | 'from' | 'to'>) {
    const qb = this.events.createQueryBuilder('e').where('e.organizationId = :orgId', { orgId });
    // A non-admin can only ever read their own activity.
    const scopeMe = !caller.isAdmin || q.scope === 'me';
    if (scopeMe) qb.andWhere('e.actorId = :me', { me: caller.userId });
    else if (q.actorId) qb.andWhere('e.actorId = :actorId', { actorId: q.actorId });
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    if (from) qb.andWhere('e.createdAt >= :from', { from });
    if (to) qb.andWhere('e.createdAt <= :to', { to });
    return qb;
  }
}
