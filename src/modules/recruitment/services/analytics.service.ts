import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';

import {
  ApplicationStageEventEntity, CandidateApplicationEntity, CandidateEntity, CandidateOfferEntity, InterviewEntity,
  RecruitmentOpeningEntity, RecruitmentSubmissionEntity,
} from '../entities';
import { InterviewsService } from './interviews.service';
import { MatchingService } from './matching.service';
import { POOL_SQL } from './candidates.service';
import { ACTIVE_SUBMISSION_STATUSES } from '../submission-rules';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller } from './recruitment-caller';

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Recruitment dashboard numbers. Computed in memory from org-scoped rows — the
 * talent pool of a single company is small enough (thousands, not millions)
 * that this stays fast and keeps the maths easy to verify.
 */
@Injectable()
export class RecruitmentAnalyticsService {
  constructor(
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(CandidateApplicationEntity) private readonly applications: Repository<CandidateApplicationEntity>,
    @InjectRepository(ApplicationStageEventEntity) private readonly events: Repository<ApplicationStageEventEntity>,
    @InjectRepository(RecruitmentOpeningEntity) private readonly openings: Repository<RecruitmentOpeningEntity>,
    @InjectRepository(InterviewEntity) private readonly interviews: Repository<InterviewEntity>,
    @InjectRepository(CandidateOfferEntity) private readonly offers: Repository<CandidateOfferEntity>,
    private readonly pipeline: PipelineService,
    private readonly interviewsService: InterviewsService,
    private readonly matching: MatchingService,
    @InjectRepository(RecruitmentSubmissionEntity) private readonly submissions: Repository<RecruitmentSubmissionEntity>,
  ) {}

  async overview(caller: RecruitmentCaller, f: { openingId?: string; days?: string }) {
    const orgId = caller.orgId;
    const now = Date.now();
    const days = Math.min(Math.max(Number(f.days) || 90, 7), 730);
    const since = new Date(now - days * DAY);

    const appWhere: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (f.openingId) appWhere.openingId = f.openingId;

    const [stages, openings, apps, candidateRows, upcoming, pendingFeedback, offers] = await Promise.all([
      this.pipeline.ensureStages(orgId),
      this.openings.find({ where: { organizationId: orgId, isDeleted: false } }),
      this.applications.find({ where: appWhere }),
      this.candidates.find({
        where: { organizationId: orgId, isDeleted: false },
        select: { id: true, source: true, createdAt: true, status: true, ownerId: true, lastActivityAt: true, fullName: true, updatedAt: true },
      }),
      this.interviewsService.upcoming(orgId, 7),
      this.interviewsService.pendingFeedbackCount(orgId),
      this.offers.find({ where: { organizationId: orgId, isDeleted: false } }),
    ]);
    const [talentPool, poolMatches, subRows] = await Promise.all([
      this.candidates.createQueryBuilder('c')
        .where(`c.organization_id = :orgId AND c.is_deleted = false AND c.status <> 'archived'`, { orgId })
        .andWhere(POOL_SQL.unassigned).getCount(),
      this.matching.poolMatchCount(orgId),
      this.submissions.find({ where: { organizationId: orgId, isDeleted: false }, select: { id: true, status: true, decidedAt: true, leadId: true } }),
    ]);
    const appIds = apps.map((a) => a.id);
    const events = appIds.length ? await this.events.find({ where: { organizationId: orgId, applicationId: In(appIds) }, order: { at: 'ASC' } }) : [];
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const openingById = new Map(openings.map((o) => [o.id, o]));
    const candById = new Map(candidateRows.map((c) => [c.id, c]));

    // ── funnel: how many applications ever reached each stage (by pipeline order) ──
    const eventsByApp = new Map<string, ApplicationStageEventEntity[]>();
    for (const e of events) {
      const list = eventsByApp.get(e.applicationId) ?? [];
      list.push(e);
      eventsByApp.set(e.applicationId, list);
    }
    const recentApps = apps.filter((a) => new Date(a.appliedAt).getTime() >= since.getTime());
    const activeStages = stages.filter((s) => s.kind !== 'rejected');
    const funnel = activeStages.map((s) => {
      const reached = recentApps.filter((a) => {
        const visited = new Set([a.stageId, ...(eventsByApp.get(a.id) ?? []).map((e) => e.toStageId)]);
        // Reaching a later stage implies passing this one.
        return [...visited].some((id) => {
          const v = stageById.get(id);
          return v && v.kind !== 'rejected' && v.order >= s.order;
        });
      }).length;
      const current = apps.filter((a) => a.stageId === s.id && a.status !== 'withdrawn').length;
      return { stageId: s.id, name: s.name, color: s.color, kind: s.kind, reached, current };
    });

    // ── time in stage (days), from consecutive events ──
    const stageDurations = new Map<string, number[]>();
    for (const a of apps) {
      const list = eventsByApp.get(a.id) ?? [];
      list.forEach((e, idx) => {
        const end = list[idx + 1] ? new Date(list[idx + 1].at).getTime() : (a.status === 'active' ? now : null);
        if (end == null) return;
        const d = (end - new Date(e.at).getTime()) / DAY;
        const arr = stageDurations.get(e.toStageId) ?? [];
        arr.push(d);
        stageDurations.set(e.toStageId, arr);
      });
    }
    const timeInStage = stages.filter((s) => s.kind === 'active').map((s) => {
      const arr = stageDurations.get(s.id) ?? [];
      return { stageId: s.id, name: s.name, avgDays: arr.length ? round1(arr.reduce((x, y) => x + y, 0) / arr.length) : null, samples: arr.length };
    });

    // ── hires, time to hire, rejections ──
    const hires = apps.filter((a) => a.status === 'hired' && a.hiredAt);
    const recentHires = hires.filter((a) => new Date(a.hiredAt!).getTime() >= since.getTime());
    const timeToHireDays = recentHires.length
      ? round1(recentHires.reduce((s, a) => s + (new Date(a.hiredAt!).getTime() - new Date(a.appliedAt).getTime()) / DAY, 0) / recentHires.length)
      : null;
    const rejectionReasons = Object.entries(
      apps.filter((a) => a.status === 'rejected' && a.rejectedAt && new Date(a.rejectedAt).getTime() >= since.getTime())
        .reduce<Record<string, number>>((acc, a) => { const k = a.rejectionReason || 'Unspecified'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    ).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

    // ── sources ──
    const bySourceMap = new Map<string, { candidates: number; applications: number; interviewed: number; hired: number }>();
    const interviewStage = stages.find((s) => s.name.toLowerCase().includes('interview'));
    for (const c of candidateRows.filter((x) => new Date(x.createdAt).getTime() >= since.getTime())) {
      const row = bySourceMap.get(c.source) ?? { candidates: 0, applications: 0, interviewed: 0, hired: 0 };
      row.candidates += 1;
      bySourceMap.set(c.source, row);
    }
    for (const a of recentApps) {
      const src = candById.get(a.candidateId)?.source ?? 'other';
      const row = bySourceMap.get(src) ?? { candidates: 0, applications: 0, interviewed: 0, hired: 0 };
      row.applications += 1;
      if (a.status === 'hired') row.hired += 1;
      if (interviewStage) {
        const visited = [a.stageId, ...(eventsByApp.get(a.id) ?? []).map((e) => e.toStageId)];
        if (visited.some((id) => { const v = stageById.get(id); return v && v.kind !== 'rejected' && v.order >= interviewStage.order; })) row.interviewed += 1;
      }
      bySourceMap.set(src, row);
    }
    const bySource = [...bySourceMap.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.candidates - a.candidates);

    // ── monthly trend (last 6 months) ──
    const monthly: { month: string; label: string; added: number; hired: number }[] = [];
    const d0 = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1);
      monthly.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en-IN', { month: 'short' }), added: 0, hired: 0 });
    }
    const monthKey = (t: Date) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
    const mIdx = new Map(monthly.map((m, i) => [m.month, i]));
    for (const c of candidateRows) { const i = mIdx.get(monthKey(new Date(c.createdAt))); if (i != null) monthly[i].added += 1; }
    for (const a of hires) { const i = mIdx.get(monthKey(new Date(a.hiredAt!))); if (i != null) monthly[i].hired += 1; }

    // ── openings health ──
    const openingsHealth = openings
      .filter((o) => o.status === 'open' || o.status === 'on_hold')
      .map((o) => {
        const oa = apps.filter((a) => a.openingId === o.id);
        return {
          id: o.id, title: o.title, status: o.status, priority: o.priority, positions: o.positions,
          active: oa.filter((a) => a.status === 'active').length, hired: oa.filter((a) => a.status === 'hired').length,
          daysOpen: o.openedAt ? Math.floor((now - new Date(o.openedAt).getTime()) / DAY) : null,
          lastMovementAt: oa.map((a) => new Date(a.stageChangedAt).getTime()).sort((x, y) => y - x)[0] ?? null,
          targetDate: o.targetDate,
        };
      })
      .sort((a, b) => (b.daysOpen ?? 0) - (a.daysOpen ?? 0));

    // ── recruiter activity (last 30 days of stage moves + candidates added) ──
    const monthAgo = now - 30 * DAY;
    const movesByUser = new Map<string, number>();
    for (const e of events) if (e.byUserId && new Date(e.at).getTime() >= monthAgo && e.fromStageId) movesByUser.set(e.byUserId, (movesByUser.get(e.byUserId) ?? 0) + 1);
    const addedByOwner = new Map<string, number>();
    const recentlyAdded = await this.candidates.find({ where: { organizationId: orgId, isDeleted: false, createdAt: MoreThan(new Date(monthAgo)) }, select: { id: true, createdBy: true } });
    for (const c of recentlyAdded) if (c.createdBy) addedByOwner.set(c.createdBy, (addedByOwner.get(c.createdBy) ?? 0) + 1);
    const userIds = [...new Set([...movesByUser.keys(), ...addedByOwner.keys()])];
    const names = await this.pipeline.userNames(userIds);
    const recruiters = userIds.map((id) => ({ userId: id, name: names.get(id) ?? 'Member', stageMoves: movesByUser.get(id) ?? 0, candidatesAdded: addedByOwner.get(id) ?? 0 }))
      .sort((a, b) => b.stageMoves + b.candidatesAdded - (a.stageMoves + a.candidatesAdded)).slice(0, 10);

    // ── needs attention: active applications idle for 7+ days ──
    const stale = apps
      .filter((a) => a.status === 'active')
      .map((a) => {
        const c = candById.get(a.candidateId);
        const last = Math.max(new Date(a.stageChangedAt).getTime(), c?.lastActivityAt ? new Date(c.lastActivityAt).getTime() : 0);
        return { a, c, idleDays: Math.floor((now - last) / DAY) };
      })
      .filter((x) => x.c && x.idleDays >= 7)
      .sort((x, y) => y.idleDays - x.idleDays)
      .slice(0, 10)
      .map(({ a, c, idleDays }) => ({
        applicationId: a.id, candidateId: c!.id, candidateName: c!.fullName, openingTitle: openingById.get(a.openingId)?.title ?? 'Category',
        stageName: stageById.get(a.stageId)?.name ?? '—', idleDays,
      }));

    const upcomingCands = upcoming.length ? await this.candidates.find({ where: { id: In([...new Set(upcoming.map((i) => i.candidateId))]) }, select: { id: true, fullName: true } }) : [];
    const upcomingNames = new Map(upcomingCands.map((c) => [c.id, c.fullName]));
    const weekEnd = now + 7 * DAY;

    return {
      rangeDays: days,
      totals: {
        openOpenings: openings.filter((o) => o.status === 'open').length,
        openPositions: openings.filter((o) => o.status === 'open').reduce((s, o) => s + (o.positions || 1), 0),
        totalCandidates: candidateRows.filter((c) => c.status !== 'archived').length,
        activeApplications: apps.filter((a) => a.status === 'active').length,
        // People, not entries: one candidate can sit in several openings (matches the Candidates → In pipeline tab).
        candidatesInPipeline: new Set(apps.filter((a) => a.status === 'active' && candById.has(a.candidateId)).map((a) => a.candidateId)).size,
        newCandidates: candidateRows.filter((c) => new Date(c.createdAt).getTime() >= since.getTime()).length,
        interviewsThisWeek: upcoming.filter((i) => new Date(i.scheduledAt).getTime() <= weekEnd).length,
        pendingFeedback,
        offersOut: offers.filter((o) => o.status === 'sent').length,
        offersAccepted: offers.filter((o) => o.status === 'accepted' && o.respondedAt && new Date(o.respondedAt).getTime() >= since.getTime()).length,
        offerAcceptanceRate: (() => {
          const decided = offers.filter((o) => (o.status === 'accepted' || o.status === 'declined') && o.respondedAt && new Date(o.respondedAt).getTime() >= since.getTime());
          return decided.length ? round1((decided.filter((o) => o.status === 'accepted').length / decided.length) * 100) : null;
        })(),
        hires: recentHires.length,
        timeToHireDays,
        talentPool,
        poolMatches,
        activeSubmissions: subRows.filter((x) => ACTIVE_SUBMISSION_STATUSES.includes(x.status)).length,
        placements: subRows.filter((x) => x.status === 'onboarded' && x.decidedAt && new Date(x.decidedAt).getTime() >= since.getTime()).length,
        clientSelections: subRows.filter((x) => (x.status === 'client_selected' || x.status === 'onboarded') && x.decidedAt && new Date(x.decidedAt).getTime() >= since.getTime()).length,
      },
      submissionsByStatus: subRows.reduce<Record<string, number>>((acc, x) => { acc[x.status] = (acc[x.status] ?? 0) + 1; return acc; }, {}),
      funnel,
      timeInStage,
      bySource,
      rejectionReasons,
      monthly,
      openings: openingsHealth,
      recruiters,
      stale,
      upcomingInterviews: upcoming.slice(0, 10).map((i) => ({
        id: i.id, roundName: i.roundName, scheduledAt: i.scheduledAt, candidateId: i.candidateId,
        candidateName: upcomingNames.get(i.candidateId) ?? 'Candidate', openingTitle: (i.openingId && openingById.get(i.openingId)?.title) || (i.kind === 'client' ? 'Client round' : 'Category'),
      })),
    };
  }
}
