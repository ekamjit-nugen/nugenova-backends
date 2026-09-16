import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, MoreThan, Repository } from 'typeorm';

import { MeetingsService } from '../../meetings/meetings.service';
import { LeadEntity } from '../../sales/entities/lead.entity';
import {
  CandidateDocumentEntity, CandidateEntity, InterviewEntity, InterviewFeedbackEntity, RecruitmentOpeningEntity, RecruitmentSubmissionEntity,
} from '../entities';
import { RECRUITMENT_NOTIFICATIONS } from '../recruitment.constants';
import { CreateInterviewDto, SubmitFeedbackDto, UpdateInterviewDto } from '../dto';
import { PipelineService } from './pipeline.service';
import { SubmissionsService } from './submissions.service';
import { RecruitmentCaller, assertCan, can, toNum } from './recruitment-caller';

const RECOMMENDATION_LABEL: Record<string, string> = { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' };

/**
 * Interview rounds + scorecard feedback. Scheduling needs `recruitment:edit`;
 * any assigned interviewer can read their interview and submit their own
 * scorecard. Interviewers see colleagues' feedback only after submitting their
 * own (avoids anchoring). A half-hourly sweep nudges interviewers whose
 * feedback is overdue.
 */
@Injectable()
export class InterviewsService {
  private readonly logger = new Logger(InterviewsService.name);

  constructor(
    @InjectRepository(InterviewEntity) private readonly interviews: Repository<InterviewEntity>,
    @InjectRepository(InterviewFeedbackEntity) private readonly feedback: Repository<InterviewFeedbackEntity>,
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(RecruitmentOpeningEntity) private readonly openings: Repository<RecruitmentOpeningEntity>,
    @InjectRepository(CandidateDocumentEntity) private readonly documents: Repository<CandidateDocumentEntity>,
    @InjectRepository(RecruitmentSubmissionEntity) private readonly submissionRepo: Repository<RecruitmentSubmissionEntity>,
    @InjectRepository(LeadEntity) private readonly leads: Repository<LeadEntity>,
    private readonly pipeline: PipelineService,
    private readonly submissionsService: SubmissionsService,
    @Optional() private readonly meetings?: MeetingsService,
  ) {}

  private async requireInterview(orgId: string, id: string) {
    const i = await this.interviews.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!i) throw new NotFoundException('Interview not found');
    return i;
  }

  private assertCanSee(caller: RecruitmentCaller, i: InterviewEntity) {
    if (can(caller, 'view') || i.interviewerIds.includes(caller.userId)) return;
    throw new NotFoundException('Interview not found');
  }

  private endOf(i: InterviewEntity) {
    return new Date(new Date(i.scheduledAt).getTime() + (i.durationMin || 60) * 60_000);
  }

  // ── read ───────────────────────────────────────────────────────────────────────

  async list(caller: RecruitmentCaller, f: { scope?: string; from?: string; to?: string; status?: string; openingId?: string; candidateId?: string; pendingFeedback?: string }) {
    const scope = f.scope === 'all' ? 'all' : 'mine';
    if (scope === 'all') assertCan(caller, 'view');
    const qb = this.interviews.createQueryBuilder('i').where('i.organization_id = :orgId AND i.is_deleted = false', { orgId: caller.orgId });
    if (scope === 'mine') qb.andWhere('i.interviewer_ids @> :me::jsonb', { me: JSON.stringify([caller.userId]) });
    if (f.status) qb.andWhere('i.status IN (:...statuses)', { statuses: f.status.split(',') });
    if (f.openingId) qb.andWhere('i.opening_id = :openingId', { openingId: f.openingId });
    if (f.candidateId) qb.andWhere('i.candidate_id = :candidateId', { candidateId: f.candidateId });
    const from = f.from ? new Date(f.from) : null;
    const to = f.to ? new Date(f.to) : null;
    if (from && !Number.isNaN(from.getTime())) qb.andWhere('i.scheduled_at >= :from', { from });
    if (to && !Number.isNaN(to.getTime())) qb.andWhere('i.scheduled_at <= :to', { to });
    if (f.pendingFeedback === '1') {
      qb.andWhere(`i.status IN ('scheduled','completed') AND i.scheduled_at <= now()`)
        .andWhere(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(i.interviewer_ids) iv WHERE NOT EXISTS (
          SELECT 1 FROM recruitment_interview_feedback fb WHERE fb.interview_id = i.id AND fb.interviewer_id = iv))`);
    }
    const rows = await qb.orderBy('i.scheduled_at', 'ASC').take(500).getMany();
    return this.decorate(caller, rows);
  }

  /** What the round is for: the opening title, or the client for a lead submission. */
  private async targetLabels(rows: InterviewEntity[]): Promise<Map<string, { title: string; leadId: string | null }>> {
    const openingIds = [...new Set(rows.map((r) => r.openingId).filter((x): x is string => !!x))];
    const subIds = [...new Set(rows.map((r) => r.submissionId).filter((x): x is string => !!x))];
    const [openings, subs] = await Promise.all([
      openingIds.length ? this.openings.find({ where: { id: In(openingIds) } }) : Promise.resolve([] as RecruitmentOpeningEntity[]),
      subIds.length ? this.submissionRepo.find({ where: { id: In(subIds) } }) : Promise.resolve([] as RecruitmentSubmissionEntity[]),
    ]);
    const leads = subs.length ? await this.leads.find({ where: { id: In([...new Set(subs.map((x) => x.leadId))]) } }) : [];
    const oById = new Map(openings.map((o) => [o.id, o]));
    const sById = new Map(subs.map((x) => [x.id, x]));
    const lById = new Map(leads.map((l) => [l.id, l]));
    const out = new Map<string, { title: string; leadId: string | null }>();
    for (const r of rows) {
      if (r.submissionId) {
        const lead = lById.get(sById.get(r.submissionId)?.leadId ?? '');
        out.set(r.id, { title: `Client: ${lead ? lead.company || lead.name : 'lead'}`, leadId: lead?.id ?? null });
      } else {
        out.set(r.id, { title: (r.openingId && oById.get(r.openingId)?.title) || 'Opening', leadId: null });
      }
    }
    return out;
  }

  /** Client rounds for a set of submissions (lead workspace). */
  async listForSubmissions(caller: RecruitmentCaller, submissionIds: string[]) {
    if (!submissionIds.length) return [];
    const rows = await this.interviews.find({ where: { organizationId: caller.orgId, submissionId: In(submissionIds), isDeleted: false }, order: { scheduledAt: 'DESC' } });
    const decorated = await this.decorate(caller, rows);
    const fb = rows.length ? await this.feedback.find({ where: { organizationId: caller.orgId, interviewId: In(rows.map((r) => r.id)) } }) : [];
    const names = await this.pipeline.userNames(fb.map((f) => f.interviewerId));
    return decorated.map((i) => ({
      ...i,
      feedback: fb.filter((f) => f.interviewId === i.id).map((f) => ({ ...f, overallRating: toNum(f.overallRating), interviewerName: names.get(f.interviewerId) ?? 'Member' })),
    }));
  }

  private async decorate(caller: RecruitmentCaller, rows: InterviewEntity[]) {
    if (!rows.length) return [];
    const [cands, labels, fb] = await Promise.all([
      this.candidates.find({ where: { id: In([...new Set(rows.map((r) => r.candidateId))]) } }),
      this.targetLabels(rows),
      this.feedback.find({ where: { organizationId: caller.orgId, interviewId: In(rows.map((r) => r.id)) } }),
    ]);
    const names = await this.pipeline.userNames(rows.flatMap((r) => r.interviewerIds));
    const candById = new Map(cands.map((c) => [c.id, c]));
    return rows.map((i) => {
      const mine = fb.filter((f) => f.interviewId === i.id);
      const c = candById.get(i.candidateId);
      return {
        ...i,
        endsAt: this.endOf(i),
        candidate: c ? { id: c.id, fullName: c.fullName, currentDesignation: c.currentDesignation, currentCompany: c.currentCompany, totalExpMonths: c.totalExpMonths } : null,
        openingTitle: labels.get(i.id)?.title ?? 'Opening',
        leadId: labels.get(i.id)?.leadId ?? null,
        interviewers: i.interviewerIds.map((uid) => ({ id: uid, name: names.get(uid) ?? 'Member', submitted: mine.some((f) => f.interviewerId === uid) })),
        feedbackCount: mine.length,
        myFeedbackSubmitted: mine.some((f) => f.interviewerId === caller.userId),
        isInterviewer: i.interviewerIds.includes(caller.userId),
      };
    });
  }

  async get(caller: RecruitmentCaller, id: string) {
    const i = await this.requireInterview(caller.orgId, id);
    this.assertCanSee(caller, i);
    const [decorated] = await this.decorate(caller, [i]);
    const fb = await this.feedback.find({ where: { organizationId: caller.orgId, interviewId: id }, order: { submittedAt: 'ASC' } });
    const mine = fb.find((f) => f.interviewerId === caller.userId) ?? null;
    const canSeeAll = can(caller, 'view') || !!mine;
    const names = await this.pipeline.userNames(fb.map((f) => f.interviewerId));
    const resume = await this.documents.findOne({ where: { organizationId: caller.orgId, candidateId: i.candidateId, kind: 'resume', isPrimary: true, isDeleted: false } });
    const candidate = await this.candidates.findOne({ where: { id: i.candidateId } });
    return {
      ...decorated,
      candidateProfile: candidate ? {
        id: candidate.id, fullName: candidate.fullName, email: candidate.email, phone: candidate.phone, currentLocation: candidate.currentLocation,
        currentCompany: candidate.currentCompany, currentDesignation: candidate.currentDesignation, totalExpMonths: candidate.totalExpMonths,
        noticePeriodDays: candidate.noticePeriodDays, noticeStatus: candidate.noticeStatus, skills: candidate.skills, highestQualification: candidate.highestQualification,
        linkedinUrl: candidate.linkedinUrl, githubUrl: candidate.githubUrl, aiSummary: candidate.aiSummary,
      } : null,
      resume: resume ? { id: resume.id, fileId: resume.fileId, fileName: resume.fileName, mimeType: resume.mimeType } : null,
      myFeedback: mine ? { ...mine, overallRating: toNum(mine.overallRating) } : null,
      feedback: (canSeeAll ? fb : []).map((f) => ({ ...f, overallRating: toNum(f.overallRating), interviewerName: names.get(f.interviewerId) ?? 'Member' })),
      feedbackHidden: !canSeeAll && fb.length > 0,
    };
  }

  // ── write ──────────────────────────────────────────────────────────────────────

  async create(caller: RecruitmentCaller, dto: CreateInterviewDto) {
    if (!dto.applicationId === !dto.submissionId) throw new BadRequestException('Choose either an opening application or a client submission');
    const app = dto.applicationId ? await this.pipeline.requireApplication(caller.orgId, dto.applicationId) : null;
    const sub = dto.submissionId ? await this.submissionsService.requireSubmission(caller.orgId, dto.submissionId) : null;
    if (sub && ['onboarded', 'client_rejected', 'withdrawn'].includes(sub.status)) {
      throw new BadRequestException('This submission is closed — reopen it before scheduling a client round');
    }
    const candidate = await this.pipeline.requireCandidate(caller.orgId, (app?.candidateId ?? sub?.candidateId)!);
    const opening = app ? await this.pipeline.requireOpening(caller.orgId, app.openingId) : null;
    const lead = sub ? await this.submissionsService.requireLead(caller.orgId, sub.leadId) : null;
    const targetTitle = opening ? opening.title : `Client: ${lead!.company || lead!.name}`;
    const interviewerIds = [...new Set(dto.interviewerIds)];
    if (!interviewerIds.length) throw new BadRequestException('Add at least one interviewer');
    await this.pipeline.assertMembers(caller.orgId, interviewerIds);
    const scheduledAt = new Date(dto.scheduledAt);
    const criteria = dto.criteria?.length
      ? [...new Set(dto.criteria.map((c) => c.trim()).filter(Boolean))]
      : await this.pipeline.scorecardCriteria(caller.orgId, dto.scorecardTemplateId ?? opening?.scorecardTemplateId);

    const i = this.interviews.create({
      organizationId: caller.orgId, applicationId: app?.id ?? null, submissionId: sub?.id ?? null, kind: sub ? 'client' : 'internal',
      candidateId: candidate.id, openingId: opening?.id ?? null,
      roundName: dto.roundName.trim(), type: dto.type ?? 'video', scheduledAt, durationMin: dto.durationMin ?? 60,
      interviewerIds, location: dto.location?.trim() || null, meetingLink: dto.meetingLink ?? null, meetingId: null,
      criteria, notes: dto.notes?.trim() || null, status: 'scheduled', createdBy: caller.userId, isDeleted: false,
    });

    if (dto.createMeeting && this.meetings) {
      try {
        const m = await this.meetings.create(caller.orgId, { userId: caller.userId, isAdmin: caller.isAdmin }, {
          title: `Interview: ${candidate.fullName} — ${i.roundName}`.slice(0, 200),
          description: `${targetTitle} · ${i.roundName}`,
          scheduledStart: scheduledAt.toISOString(),
          scheduledEnd: this.endOf(i).toISOString(),
          participantIds: interviewerIds.filter((id) => id !== caller.userId),
        } as any);
        i.meetingId = (m as { id: string }).id;
      } catch (err) {
        this.logger.warn(`could not create meeting for interview: ${(err as Error).message}`);
      }
    }
    const saved = await this.interviews.save(i);

    const when = scheduledAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
    await this.pipeline.logActivity(caller.orgId, candidate.id, 'interview', `Scheduled ${sub ? 'client ' : ''}${saved.roundName} (${saved.type}) for ${when} IST${sub ? ` — ${targetTitle.replace(/^Client: /, '')}` : ''}`, {
      applicationId: app?.id ?? null, actorId: caller.userId, meta: { interviewId: saved.id, submissionId: sub?.id ?? null },
    });
    if (sub) await this.submissionsService.advanceTo(caller, sub.id, 'client_interview', `${saved.roundName} scheduled for ${when} IST`);
    for (const uid of interviewerIds) {
      this.pipeline.notify({
        organizationId: caller.orgId, userId: uid, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.INTERVIEW_SCHEDULED,
        title: `Interview: ${candidate.fullName} — ${saved.roundName}`, body: `${targetTitle} · ${when} IST`,
        data: { actionUrl: `/recruitment/interviews/${saved.id}`, interviewId: saved.id },
      });
    }
    this.pipeline.audit(caller, 'recruitment.interview_scheduled', `Scheduled ${saved.roundName} with ${candidate.fullName}`, { type: 'interview', id: saved.id });
    return (await this.decorate(caller, [saved]))[0];
  }

  async update(caller: RecruitmentCaller, id: string, dto: UpdateInterviewDto) {
    const i = await this.requireInterview(caller.orgId, id);
    const before = { scheduledAt: new Date(i.scheduledAt).getTime(), interviewerIds: [...i.interviewerIds], status: i.status };
    if (dto.interviewerIds !== undefined) {
      const ids = [...new Set(dto.interviewerIds)];
      if (!ids.length) throw new BadRequestException('Add at least one interviewer');
      await this.pipeline.assertMembers(caller.orgId, ids);
      i.interviewerIds = ids;
    }
    if (dto.roundName !== undefined) i.roundName = dto.roundName.trim() || i.roundName;
    if (dto.type !== undefined) i.type = dto.type;
    if (dto.scheduledAt !== undefined) { i.scheduledAt = new Date(dto.scheduledAt); i.feedbackRemindedAt = null; }
    if (dto.durationMin !== undefined) i.durationMin = dto.durationMin;
    if (dto.location !== undefined) i.location = dto.location?.trim() || null;
    if (dto.meetingLink !== undefined) i.meetingLink = dto.meetingLink?.trim() || null;
    if (dto.criteria !== undefined) i.criteria = [...new Set(dto.criteria.map((c) => c.trim()).filter(Boolean))];
    if (dto.notes !== undefined) i.notes = dto.notes?.trim() || null;
    if (dto.status !== undefined) i.status = dto.status as InterviewEntity['status'];
    const saved = await this.interviews.save(i);

    const candidate = await this.candidates.findOne({ where: { id: i.candidateId } });
    const rescheduled = new Date(saved.scheduledAt).getTime() !== before.scheduledAt;
    const cancelled = saved.status === 'cancelled' && before.status !== 'cancelled';
    const when = new Date(saved.scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

    if (saved.meetingId && this.meetings) {
      const meetingCaller = { userId: caller.userId, isAdmin: true };
      try {
        if (cancelled) await this.meetings.cancel(caller.orgId, meetingCaller, saved.meetingId);
        else if (rescheduled || dto.interviewerIds !== undefined) {
          await this.meetings.update(caller.orgId, meetingCaller, saved.meetingId, {
            scheduledStart: new Date(saved.scheduledAt).toISOString(), scheduledEnd: this.endOf(saved).toISOString(), participantIds: saved.interviewerIds,
          } as any);
        }
      } catch (err) {
        this.logger.warn(`could not sync meeting ${saved.meetingId}: ${(err as Error).message}`);
      }
    }

    if (candidate && (cancelled || rescheduled)) {
      await this.pipeline.logActivity(caller.orgId, candidate.id, 'interview',
        cancelled ? `Cancelled ${saved.roundName}` : `Rescheduled ${saved.roundName} to ${when} IST`,
        { applicationId: saved.applicationId, actorId: caller.userId, meta: { interviewId: saved.id } });
      for (const uid of saved.interviewerIds) {
        this.pipeline.notify({
          organizationId: caller.orgId, userId: uid, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.INTERVIEW_CANCELLED,
          title: cancelled ? `Interview cancelled: ${candidate.fullName}` : `Interview rescheduled: ${candidate.fullName}`,
          body: cancelled ? saved.roundName : `${saved.roundName} · now ${when} IST`,
          data: { actionUrl: `/recruitment/interviews/${saved.id}`, interviewId: saved.id },
        });
      }
    }
    const added = saved.interviewerIds.filter((uid) => !before.interviewerIds.includes(uid));
    if (candidate && added.length && saved.status === 'scheduled') {
      for (const uid of added) {
        this.pipeline.notify({
          organizationId: caller.orgId, userId: uid, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.INTERVIEW_SCHEDULED,
          title: `Interview: ${candidate.fullName} — ${saved.roundName}`, body: `${when} IST`,
          data: { actionUrl: `/recruitment/interviews/${saved.id}`, interviewId: saved.id },
        });
      }
    }
    return (await this.decorate(caller, [saved]))[0];
  }

  async remove(caller: RecruitmentCaller, id: string) {
    const i = await this.requireInterview(caller.orgId, id);
    i.isDeleted = true;
    await this.interviews.save(i);
    return { success: true as const };
  }

  async submitFeedback(caller: RecruitmentCaller, id: string, dto: SubmitFeedbackDto) {
    const i = await this.requireInterview(caller.orgId, id);
    if (!i.interviewerIds.includes(caller.userId)) throw new ForbiddenException('Only an assigned interviewer can submit feedback');
    if (i.status === 'cancelled') throw new BadRequestException('This interview was cancelled');

    const ratings: Record<string, number> = {};
    for (const [key, raw] of Object.entries(dto.ratings ?? {})) {
      const criterion = key.trim().slice(0, 120);
      if (!criterion) continue;
      if (i.criteria.length && !i.criteria.includes(criterion)) throw new BadRequestException(`Unknown criterion "${criterion}"`);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new BadRequestException(`Rating for "${criterion}" must be 1–5`);
      ratings[criterion] = n;
    }
    if (i.criteria.length && Object.keys(ratings).length < i.criteria.length) throw new BadRequestException('Rate every criterion');
    const values = Object.values(ratings);
    const overall = values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100 : null;

    const existing = await this.feedback.findOne({ where: { interviewId: id, interviewerId: caller.userId } });
    const row = existing ?? this.feedback.create({ organizationId: caller.orgId, interviewId: id, interviewerId: caller.userId });
    row.ratings = ratings;
    row.overallRating = overall != null ? String(overall) : null;
    row.recommendation = dto.recommendation as InterviewFeedbackEntity['recommendation'];
    row.strengths = dto.strengths?.trim() || null;
    row.concerns = dto.concerns?.trim() || null;
    row.notes = dto.notes?.trim() || null;
    row.submittedAt = new Date();
    const saved = await this.feedback.save(row);

    if (i.status === 'scheduled') { i.status = 'completed'; await this.interviews.save(i); }

    const [candidate, app, opening, sub] = await Promise.all([
      this.candidates.findOne({ where: { id: i.candidateId } }),
      i.applicationId ? this.pipeline.requireApplication(caller.orgId, i.applicationId).catch(() => null) : Promise.resolve(null),
      i.openingId ? this.openings.findOne({ where: { id: i.openingId } }) : Promise.resolve(null),
      i.submissionId ? this.submissionRepo.findOne({ where: { id: i.submissionId } }) : Promise.resolve(null),
    ]);
    const label = RECOMMENDATION_LABEL[saved.recommendation] ?? saved.recommendation;
    if (candidate) {
      await this.pipeline.logActivity(caller.orgId, candidate.id, 'feedback',
        `${existing ? 'Updated' : 'Submitted'} ${i.roundName} feedback: ${label}${overall != null ? ` (${overall}/5)` : ''}`,
        { applicationId: i.applicationId, actorId: caller.userId, meta: { interviewId: i.id, recommendation: saved.recommendation, overall } });
      const recipients = new Set([app?.ownerId, sub?.ownerId, candidate.ownerId, opening?.hiringManagerId, i.createdBy].filter((x): x is string => !!x && x !== caller.userId));
      for (const uid of recipients) {
        this.pipeline.notify({
          organizationId: caller.orgId, userId: uid, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.FEEDBACK_SUBMITTED,
          title: `Feedback on ${candidate.fullName}: ${label}`, body: `${i.roundName}${opening ? ` · ${opening.title}` : ''}`,
          data: { actionUrl: `/recruitment/candidates/${candidate.id}?tab=interviews`, candidateId: candidate.id, interviewId: i.id },
        });
      }
    }
    return { ...saved, overallRating: toNum(saved.overallRating) };
  }

  // ── reminders ──────────────────────────────────────────────────────────────────

  /** Nudge interviewers whose feedback is overdue (once per interview). */
  @Cron('*/30 * * * *')
  async remindPendingFeedback(now = new Date()): Promise<number> {
    if (process.env.NODE_ENV === 'test') return 0;
    try {
      const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
      const due = await this.interviews.find({
        where: { status: In(['scheduled', 'completed']), isDeleted: false, feedbackRemindedAt: IsNull(), scheduledAt: MoreThan(weekAgo) },
        take: 500,
      });
      const candidates = due.filter((i) => this.endOf(i) < now);
      if (!candidates.length) return 0;
      let sent = 0;
      const settingsCache = new Map<string, number>();
      for (const i of candidates) {
        if (!settingsCache.has(i.organizationId)) settingsCache.set(i.organizationId, (await this.pipeline.getSettings(i.organizationId)).feedbackReminderHours);
        const hours = settingsCache.get(i.organizationId)!;
        if (hours <= 0 || this.endOf(i).getTime() + hours * 3_600_000 > now.getTime()) continue;
        const fb = await this.feedback.find({ where: { interviewId: i.id } });
        const pending = i.interviewerIds.filter((uid) => !fb.some((f) => f.interviewerId === uid));
        const cand = await this.candidates.findOne({ where: { id: i.candidateId } });
        for (const uid of pending) {
          this.pipeline.notify({
            organizationId: i.organizationId, userId: uid, type: RECRUITMENT_NOTIFICATIONS.FEEDBACK_DUE,
            title: `Feedback due: ${cand?.fullName ?? 'candidate'} — ${i.roundName}`,
            body: 'Please submit your interview scorecard while it’s fresh.',
            data: { actionUrl: `/recruitment/interviews/${i.id}`, interviewId: i.id },
          });
          sent++;
        }
        await this.interviews.update({ id: i.id }, { feedbackRemindedAt: now });
      }
      if (sent) this.logger.log(`sent ${sent} interview feedback reminder(s)`);
      return sent;
    } catch (err) {
      this.logger.error(`feedback reminder sweep failed: ${String(err)}`);
      return 0;
    }
  }

  /** Upcoming interviews (dashboard helper). */
  upcoming(orgId: string, days = 7) {
    const now = new Date();
    return this.interviews.find({
      where: { organizationId: orgId, isDeleted: false, status: 'scheduled', scheduledAt: MoreThan(now) },
      order: { scheduledAt: 'ASC' }, take: 50,
    }).then((rows) => rows.filter((r) => new Date(r.scheduledAt).getTime() < now.getTime() + days * 86_400_000));
  }

  /** Interviews that ended without all feedback (dashboard helper). */
  async pendingFeedbackCount(orgId: string) {
    const rows = await this.interviews.find({ where: { organizationId: orgId, isDeleted: false, status: In(['scheduled', 'completed']), scheduledAt: LessThan(new Date()) }, take: 1000 });
    if (!rows.length) return 0;
    const fb = await this.feedback.find({ where: { organizationId: orgId, interviewId: In(rows.map((r) => r.id)) } });
    return rows.reduce((n, i) => n + i.interviewerIds.filter((uid) => !fb.some((f) => f.interviewId === i.id && f.interviewerId === uid)).length, 0);
  }
}
