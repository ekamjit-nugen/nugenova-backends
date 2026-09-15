import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { LeadEntity } from '../../sales/entities/lead.entity';
import { RequirementEntity } from '../../sales/entities/requirement.entity';
import { CandidateApplicationEntity, CandidateEntity, RecruitmentOpeningEntity, RecruitmentSubmissionEntity } from '../entities';
import { MatchCandidate, MatchTarget, scoreMatch } from '../matching';
import { ACTIVE_SUBMISSION_STATUSES } from '../submission-rules';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller, assertCan } from './recruitment-caller';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
/** Minimum score for something to be offered as a suggestion. */
export const SUGGESTION_MIN_SCORE = 40;

interface Target {
  type: 'opening' | 'requirement';
  id: string;
  title: string;
  subtitle: string | null;
  openingId: string | null;
  leadId: string | null;
  requirementId: string | null;
  match: MatchTarget;
}

/**
 * Talent-pool matching: ranks candidates for an opening / lead requirement, and
 * suggests openings / requirements for a candidate. Scoring is the pure,
 * explainable `scoreMatch` (see matching.ts); this service only loads data.
 */
@Injectable()
export class MatchingService {
  constructor(
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(RecruitmentOpeningEntity) private readonly openings: Repository<RecruitmentOpeningEntity>,
    @InjectRepository(CandidateApplicationEntity) private readonly applications: Repository<CandidateApplicationEntity>,
    @InjectRepository(RecruitmentSubmissionEntity) private readonly submissions: Repository<RecruitmentSubmissionEntity>,
    @InjectRepository(LeadEntity) private readonly leads: Repository<LeadEntity>,
    @InjectRepository(RequirementEntity) private readonly requirements: Repository<RequirementEntity>,
    private readonly pipeline: PipelineService,
  ) {}

  private toMatch(c: CandidateEntity): MatchCandidate {
    return {
      skills: c.skills ?? [], totalExpMonths: c.totalExpMonths, noticePeriodDays: c.noticePeriodDays, noticeStatus: c.noticeStatus,
      currentLocation: c.currentLocation, preferredLocations: c.preferredLocations ?? [], status: c.status,
    };
  }

  /** Open openings + open/in-progress requirements of live leads. */
  async targets(orgId: string): Promise<Target[]> {
    const [openings, leads] = await Promise.all([
      this.openings.find({ where: { organizationId: orgId, isDeleted: false, status: 'open' }, take: 300 }),
      this.leads.find({ where: { organizationId: orgId, isDeleted: false, status: In(['open', 'on_hold']) }, take: 500 }),
    ]);
    const reqs = leads.length
      ? await this.requirements.find({ where: { organizationId: orgId, entityType: 'lead', entityId: In(leads.map((l) => l.id)), isDeleted: false, status: In(['open', 'in_progress']) } })
      : [];
    const leadById = new Map(leads.map((l) => [l.id, l]));
    return [
      ...openings.map((o): Target => ({
        type: 'opening', id: o.id, title: o.title, subtitle: [o.location, o.expMinYears != null || o.expMaxYears != null ? `${o.expMinYears ?? 0}–${o.expMaxYears ?? '∞'} yrs` : null].filter(Boolean).join(' · ') || null,
        openingId: o.id, leadId: o.leadId, requirementId: o.requirementId,
        match: { skills: o.skills ?? [], expMinYears: o.expMinYears, expMaxYears: o.expMaxYears, location: o.location, workMode: o.workMode, neededBy: o.targetDate },
      })),
      ...reqs.map((r): Target => {
        const l = leadById.get(r.entityId)!;
        return {
          type: 'requirement', id: r.id, title: r.role || r.title, subtitle: l.company || l.name,
          openingId: null, leadId: l.id, requirementId: r.id,
          match: { skills: r.skills ?? [], neededBy: r.neededBy },
        };
      }),
    ];
  }

  /** Best suggestions for one candidate across all open targets. */
  async suggestionsFor(caller: RecruitmentCaller, candidateId: string, limit = 6) {
    assertCan(caller, 'view');
    const c = await this.pipeline.requireCandidate(caller.orgId, candidateId);
    const [targets, apps, subs] = await Promise.all([
      this.targets(caller.orgId),
      this.applications.find({ where: { organizationId: caller.orgId, candidateId, isDeleted: false } }),
      this.submissions.find({ where: { organizationId: caller.orgId, candidateId, isDeleted: false } }),
    ]);
    return this.rank(c, targets, new Set(apps.map((a) => a.openingId)), new Set(subs.map((s) => s.requirementId ?? `lead:${s.leadId}`)))
      .filter((s) => s.score >= SUGGESTION_MIN_SCORE)
      .slice(0, limit);
  }

  private rank(c: CandidateEntity, targets: Target[], openingIds: Set<string>, requirementKeys: Set<string>) {
    const m = this.toMatch(c);
    return targets
      .filter((t) => (t.type === 'opening' ? !openingIds.has(t.id) : !requirementKeys.has(t.id)))
      .map((t) => {
        const s = scoreMatch(m, t.match);
        return s ? { type: t.type, id: t.id, title: t.title, subtitle: t.subtitle, openingId: t.openingId, leadId: t.leadId, requirementId: t.requirementId, score: s.score, reasons: s.reasons } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.score - a.score);
  }

  /** Top suggestion per candidate for list rows (targets loaded once). */
  async topSuggestionFor(orgId: string, rows: CandidateEntity[]) {
    if (!rows.length) return new Map<string, ReturnType<MatchingService['rank']>[number]>();
    const ids = rows.map((r) => r.id);
    const [targets, apps, subs] = await Promise.all([
      this.targets(orgId),
      this.applications.find({ where: { organizationId: orgId, candidateId: In(ids), isDeleted: false } }),
      this.submissions.find({ where: { organizationId: orgId, candidateId: In(ids), isDeleted: false } }),
    ]);
    const out = new Map<string, ReturnType<MatchingService['rank']>[number]>();
    if (!targets.length) return out;
    for (const c of rows) {
      const best = this.rank(
        c, targets,
        new Set(apps.filter((a) => a.candidateId === c.id).map((a) => a.openingId)),
        new Set(subs.filter((s) => s.candidateId === c.id).map((s) => s.requirementId ?? `lead:${s.leadId}`)),
      )[0];
      if (best && best.score >= SUGGESTION_MIN_SCORE) out.set(c.id, best);
    }
    return out;
  }

  /** Ranked candidates for an opening or a lead requirement. */
  async matchesFor(caller: RecruitmentCaller, q: { openingId?: string; requirementId?: string; limit?: string | number }) {
    assertCan(caller, 'view');
    if (!q.openingId === !q.requirementId) throw new BadRequestException('Pass exactly one of openingId or requirementId');
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    let target: MatchTarget;
    let linked: Set<string>;
    if (q.openingId) {
      const o = await this.pipeline.requireOpening(caller.orgId, q.openingId);
      target = { skills: o.skills ?? [], expMinYears: o.expMinYears, expMaxYears: o.expMaxYears, location: o.location, workMode: o.workMode, neededBy: o.targetDate };
      linked = new Set((await this.applications.find({ where: { organizationId: caller.orgId, openingId: o.id, isDeleted: false } })).map((a) => a.candidateId));
    } else {
      const r = await this.requirements.findOne({ where: { id: q.requirementId, organizationId: caller.orgId, entityType: 'lead', isDeleted: false } });
      if (!r) throw new NotFoundException('Requirement not found');
      target = { skills: r.skills ?? [], neededBy: r.neededBy };
      linked = new Set((await this.submissions.find({ where: { organizationId: caller.orgId, requirementId: r.id, isDeleted: false } })).map((s) => s.candidateId));
    }

    // Pre-filter in SQL to candidates sharing at least one skill (or everyone when the target lists none).
    const qb = this.candidates.createQueryBuilder('c')
      .where(`c.organization_id = :orgId AND c.is_deleted = false AND c.status IN ('active', 'on_hold')`, { orgId: caller.orgId })
      .andWhere(`NOT EXISTS (SELECT 1 FROM candidate_applications a WHERE a.candidate_id = c.id AND a.is_deleted = false AND a.status = 'hired')`)
      .andWhere(`NOT EXISTS (SELECT 1 FROM recruitment_submissions s WHERE s.candidate_id = c.id AND s.is_deleted = false AND s.status = 'onboarded')`);
    const skills = target.skills.map((s) => s.trim()).filter(Boolean).slice(0, 15);
    if (skills.length) {
      const params: Record<string, string> = {};
      // Space-insensitive contains ("Power BI" ~ "PowerBI"); "pyspark" also catches plain "spark".
      const ors = skills.map((s, i) => {
        params[`sk${i}`] = `%${escapeLike(s.toLowerCase().replace(/\s+/g, '').replace(/^pyspark$/, 'spark'))}%`;
        return `replace(lower(s), ' ', '') LIKE :sk${i}`;
      });
      qb.andWhere(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.skills) s WHERE ${ors.join(' OR ')})`, params);
    }
    const rows = await qb.orderBy('c.updated_at', 'DESC').take(500).getMany();

    return rows
      .map((c) => {
        const s = scoreMatch(this.toMatch(c), target);
        if (!s) return null;
        return {
          candidate: {
            id: c.id, fullName: c.fullName, currentDesignation: c.currentDesignation, currentCompany: c.currentCompany,
            currentLocation: c.currentLocation, totalExpMonths: c.totalExpMonths, noticePeriodDays: c.noticePeriodDays,
            noticeStatus: c.noticeStatus, skills: (c.skills ?? []).slice(0, 8),
          },
          score: s.score, reasons: s.reasons, linked: linked.has(c.id) ? (q.openingId ? 'application' as const : 'submission' as const) : null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => (a.linked ? 1 : 0) - (b.linked ? 1 : 0) || b.score - a.score)
      .slice(0, limit);
  }

  /** How many talent-pool (unassigned) candidates have a suggestion ≥ 60. */
  async poolMatchCount(orgId: string): Promise<number> {
    const targets = await this.targets(orgId);
    if (!targets.length) return 0;
    const pool = await this.candidates.createQueryBuilder('c')
      .where(`c.organization_id = :orgId AND c.is_deleted = false AND c.status IN ('active', 'on_hold')`, { orgId })
      .andWhere(`NOT EXISTS (SELECT 1 FROM candidate_applications a WHERE a.candidate_id = c.id AND a.is_deleted = false AND a.status IN ('active', 'hired'))`)
      .andWhere(`NOT EXISTS (SELECT 1 FROM recruitment_submissions s WHERE s.candidate_id = c.id AND s.is_deleted = false AND s.status IN (:...subs))`, { subs: [...ACTIVE_SUBMISSION_STATUSES, 'onboarded'] })
      .take(2000).getMany();
    return pool.filter((c) => targets.some((t) => (scoreMatch(this.toMatch(c), t.match)?.score ?? 0) >= 60)).length;
  }
}
