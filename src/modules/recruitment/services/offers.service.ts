import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { CandidateEntity, CandidateOfferEntity, RecruitmentOpeningEntity } from '../entities';
import { OfferStatus, RECRUITMENT_NOTIFICATIONS } from '../recruitment.constants';
import { CreateOfferDto, OfferHandoffDto, OfferStatusDto, UpdateOfferDto } from '../dto';
import { CandidateFilesService } from './candidate-files.service';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller, can, toNum } from './recruitment-caller';

/** Allowed status transitions. */
const TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  draft: ['sent', 'revoked'],
  sent: ['accepted', 'declined', 'revoked'],
  accepted: ['revoked'],
  declined: [],
  revoked: [],
};

/**
 * Offers on an application: draft → sent → accepted / declined (or revoked).
 * Sending moves the card to an "Offer" stage when the pipeline has one;
 * accepting moves it to the first "hired" stage. Handoff links the hire to the
 * org membership created for them (the frontend creates the member through the
 * existing /org/members flow, then starts onboarding) so the recruitment record
 * and the employee record stay connected.
 */
@Injectable()
export class OffersService {
  constructor(
    @InjectRepository(CandidateOfferEntity) private readonly offers: Repository<CandidateOfferEntity>,
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(RecruitmentOpeningEntity) private readonly openings: Repository<RecruitmentOpeningEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    private readonly pipeline: PipelineService,
    private readonly cv: CandidateFilesService,
  ) {}

  private view(o: CandidateOfferEntity, caller: RecruitmentCaller) {
    return { ...o, offeredCtc: can(caller, 'edit') ? toNum(o.offeredCtc) : null };
  }

  private async requireOffer(orgId: string, id: string) {
    const o = await this.offers.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!o) throw new NotFoundException('Offer not found');
    return o;
  }

  async list(caller: RecruitmentCaller, f: { status?: string; openingId?: string; candidateId?: string }) {
    const where: Record<string, unknown> = { organizationId: caller.orgId, isDeleted: false };
    if (f.status) where.status = In(f.status.split(','));
    if (f.openingId) where.openingId = f.openingId;
    if (f.candidateId) where.candidateId = f.candidateId;
    const rows = await this.offers.find({ where, order: { updatedAt: 'DESC' }, take: 500 });
    if (!rows.length) return [];
    const [cands, openings] = await Promise.all([
      this.candidates.find({ where: { id: In([...new Set(rows.map((r) => r.candidateId))]) } }),
      this.openings.find({ where: { id: In([...new Set(rows.map((r) => r.openingId))]) } }),
    ]);
    const cById = new Map(cands.map((c) => [c.id, c]));
    const oById = new Map(openings.map((o) => [o.id, o]));
    return rows.map((o) => ({
      ...this.view(o, caller),
      candidateName: cById.get(o.candidateId)?.fullName ?? 'Candidate',
      candidateEmail: cById.get(o.candidateId)?.email ?? null,
      openingTitle: oById.get(o.openingId)?.title ?? 'Opening',
    }));
  }

  async create(caller: RecruitmentCaller, dto: CreateOfferDto) {
    const app = await this.pipeline.requireApplication(caller.orgId, dto.applicationId);
    if (app.status !== 'active' && app.status !== 'hired') throw new BadRequestException('Re-activate this application before making an offer');
    const open = await this.offers.count({ where: { organizationId: caller.orgId, applicationId: app.id, status: In(['draft', 'sent', 'accepted']), isDeleted: false } });
    if (open) throw new ConflictException('This application already has an open offer');
    if (dto.offerLetterFileId) await this.cv.requireOrgFile(caller.orgId, dto.offerLetterFileId);
    const saved = await this.offers.save(this.offers.create({
      organizationId: caller.orgId, applicationId: app.id, candidateId: app.candidateId, openingId: app.openingId,
      designation: dto.designation.trim(), departmentId: dto.departmentId ?? null,
      offeredCtc: dto.offeredCtc != null ? String(dto.offeredCtc) : null, currency: (dto.currency || 'INR').toUpperCase(),
      joiningDate: dto.joiningDate ?? null, expiresOn: dto.expiresOn ?? null, offerLetterFileId: dto.offerLetterFileId ?? null,
      notes: dto.notes?.trim() || null, status: 'draft', createdBy: caller.userId, isDeleted: false,
    }));
    await this.pipeline.logActivity(caller.orgId, app.candidateId, 'offer', `Drafted offer: ${saved.designation}`, { applicationId: app.id, actorId: caller.userId, meta: { offerId: saved.id } });
    return this.view(saved, caller);
  }

  async update(caller: RecruitmentCaller, id: string, dto: UpdateOfferDto) {
    const o = await this.requireOffer(caller.orgId, id);
    if (!['draft', 'sent'].includes(o.status)) throw new BadRequestException(`An ${o.status} offer can’t be edited`);
    if (dto.offerLetterFileId) await this.cv.requireOrgFile(caller.orgId, dto.offerLetterFileId);
    if (dto.designation !== undefined) o.designation = dto.designation.trim() || o.designation;
    if (dto.departmentId !== undefined) o.departmentId = dto.departmentId || null;
    if (dto.offeredCtc !== undefined) o.offeredCtc = dto.offeredCtc == null ? null : String(dto.offeredCtc);
    if (dto.currency !== undefined) o.currency = (dto.currency || 'INR').toUpperCase();
    if (dto.joiningDate !== undefined) o.joiningDate = dto.joiningDate || null;
    if (dto.expiresOn !== undefined) o.expiresOn = dto.expiresOn || null;
    if (dto.offerLetterFileId !== undefined) o.offerLetterFileId = dto.offerLetterFileId || null;
    if (dto.notes !== undefined) o.notes = dto.notes?.trim() || null;
    return this.view(await this.offers.save(o), caller);
  }

  async setStatus(caller: RecruitmentCaller, id: string, dto: OfferStatusDto) {
    const o = await this.requireOffer(caller.orgId, id);
    const next = dto.status as OfferStatus;
    if (next === o.status) return this.view(o, caller);
    if (!TRANSITIONS[o.status].includes(next)) throw new BadRequestException(`Can’t change an offer from ${o.status} to ${next}`);
    const now = new Date();
    o.status = next;
    if (next === 'sent') o.sentAt = now;
    if (next === 'accepted' || next === 'declined') o.respondedAt = now;
    if (next === 'declined' || next === 'revoked') o.declineReason = dto.reason?.trim() || null;
    const saved = await this.offers.save(o);

    const stages = await this.pipeline.ensureStages(caller.orgId);
    const app = await this.pipeline.requireApplication(caller.orgId, o.applicationId).catch(() => null);
    if (app) {
      if (next === 'sent') {
        const offerStage = stages.find((s) => s.kind === 'active' && s.name.trim().toLowerCase() === 'offer');
        const current = stages.find((s) => s.id === app.stageId);
        if (offerStage && current && current.kind === 'active' && current.order < offerStage.order) {
          await this.pipeline.moveApplication(caller, app.id, { stageId: offerStage.id, note: 'Offer sent' });
        }
      }
      if (next === 'accepted') {
        const hired = stages.find((s) => s.kind === 'hired');
        if (hired && app.stageId !== hired.id) await this.pipeline.moveApplication(caller, app.id, { stageId: hired.id, note: 'Offer accepted' });
      }
    }

    const label = { sent: 'Offer sent', accepted: 'Offer accepted', declined: 'Offer declined', revoked: 'Offer revoked', draft: 'Offer drafted' }[next];
    await this.pipeline.logActivity(caller.orgId, o.candidateId, 'offer', `${label}: ${o.designation}${saved.declineReason ? ` — ${saved.declineReason}` : ''}`, {
      applicationId: o.applicationId, actorId: caller.userId, meta: { offerId: o.id, status: next },
    });

    if (next === 'accepted') {
      const [candidate, opening] = await Promise.all([
        this.candidates.findOne({ where: { id: o.candidateId } }),
        this.openings.findOne({ where: { id: o.openingId } }),
      ]);
      const recipients = new Set([app?.ownerId, candidate?.ownerId, opening?.hiringManagerId, o.createdBy].filter((x): x is string => !!x && x !== caller.userId));
      for (const uid of recipients) {
        this.pipeline.notify({
          organizationId: caller.orgId, userId: uid, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.OFFER_ACCEPTED,
          title: `${candidate?.fullName ?? 'A candidate'} accepted the offer`, body: `${o.designation}${opening ? ` · ${opening.title}` : ''}`,
          data: { actionUrl: `/recruitment/candidates/${o.candidateId}?tab=offers`, candidateId: o.candidateId, offerId: o.id },
        });
      }
    }
    this.pipeline.audit(caller, `recruitment.offer_${next}`, `${label} (${o.designation})`, { type: 'offer', id: o.id });
    return this.view(saved, caller);
  }

  async handoff(caller: RecruitmentCaller, id: string, dto: OfferHandoffDto) {
    const o = await this.requireOffer(caller.orgId, id);
    if (o.status !== 'accepted') throw new BadRequestException('Only an accepted offer can be handed off to onboarding');
    const membership = await this.memberships.findOne({ where: { id: dto.membershipId, organizationId: caller.orgId } });
    if (!membership) throw new BadRequestException('That member was not found in this organization');
    o.membershipId = membership.id;
    o.handedOffAt = new Date();
    const saved = await this.offers.save(o);
    await this.pipeline.logActivity(caller.orgId, o.candidateId, 'system', `Handed off to onboarding as ${membership.email ?? 'a new member'}`, {
      applicationId: o.applicationId, actorId: caller.userId, meta: { offerId: o.id, membershipId: membership.id },
    });
    this.pipeline.audit(caller, 'recruitment.offer_handoff', `Handed off hire to onboarding`, { type: 'offer', id: o.id }, { membershipId: membership.id });
    return this.view(saved, caller);
  }

  async remove(caller: RecruitmentCaller, id: string) {
    const o = await this.requireOffer(caller.orgId, id);
    if (o.status !== 'draft') throw new BadRequestException('Only a draft offer can be deleted — revoke it instead');
    o.isDeleted = true;
    await this.offers.save(o);
    return { success: true as const };
  }
}
