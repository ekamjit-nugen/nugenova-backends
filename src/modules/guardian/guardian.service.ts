import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { GuardianLinkEntity } from './entities/guardian-link.entity';
import {
  ConsentBasis,
  ConsentLedgerEntity,
} from './entities/consent-ledger.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import {
  LinkGuardianDto,
  RecordConsentDto,
  RevokeConsentDto,
} from './dto';

export interface GuardianLinkView {
  id: string;
  organizationId: string;
  guardianMembershipId: string;
  studentMembershipId: string;
  relationship: string;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConsentView {
  id: string;
  subjectMembershipId: string;
  purpose: string;
  basis: ConsentBasis;
  grantedByMembershipId: string;
  grantedAt: Date;
  revokedAt: Date | null;
  version: number;
  active: boolean;
}

/**
 * GuardianService — the guardian↔student graph and the consent ledger it
 * authorizes (§04, §09/§10). Every method takes `orgId` from the JWT (never the
 * client) and filters on it, so one org can never read or mutate another's
 * links/consent (cross-org lookups surface as 404).
 *
 * Invariants enforced here:
 *  - A guardian link's two sides are constrained by personType — the guardian
 *    side MUST be `personType='guardian'`, the student side `personType='student'`
 *    (the same guard the LMS uses, both ways). Neither is a column constraint.
 *  - At most ONE primary guardian per student (promoting one clears the others,
 *    in a transaction).
 *  - Unlinking is SOFT; a later re-link flips the same row back (respects the
 *    (guardian, student) unique index).
 *  - Consent is APPEND-ONLY: a grant is a new row; a revoke soft-stamps the
 *    active row. A guardian may only grant/revoke for a student they are actively
 *    LINKED to; self-consent is only the subject acting for themselves.
 */
@Injectable()
export class GuardianService {
  private readonly logger = new Logger(GuardianService.name);

  constructor(
    @InjectRepository(GuardianLinkEntity)
    private readonly links: Repository<GuardianLinkEntity>,
    @InjectRepository(ConsentLedgerEntity)
    private readonly consents: Repository<ConsentLedgerEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
  ) {}

  // ── guardian links ───────────────────────────────────────────────────────

  async linkGuardian(
    orgId: string,
    dto: LinkGuardianDto,
    actorId: string,
  ): Promise<GuardianLinkView> {
    await this.assertPersonType(orgId, dto.guardianMembershipId, 'guardian');
    await this.assertPersonType(orgId, dto.studentMembershipId, 'student');

    const existing = await this.links.findOne({
      where: {
        organizationId: orgId,
        guardianMembershipId: dto.guardianMembershipId,
        studentMembershipId: dto.studentMembershipId,
      },
    });
    if (existing && existing.deactivatedAt === null) {
      throw new BadRequestException(
        'This guardian is already linked to this student',
      );
    }

    const relationship = (dto.relationship ?? 'guardian').trim() || 'guardian';
    const isPrimary = dto.isPrimary ?? false;

    const saved = await this.links.manager.transaction(async (tx) => {
      if (isPrimary) {
        await this.clearPrimaryInTx(tx, orgId, dto.studentMembershipId);
      }
      if (existing) {
        // Re-link a previously unlinked pair on the SAME row.
        existing.deactivatedAt = null;
        existing.relationship = relationship;
        existing.isPrimary = isPrimary;
        existing.updatedBy = actorId;
        return tx.save(GuardianLinkEntity, existing);
      }
      return tx.save(
        GuardianLinkEntity,
        tx.create(GuardianLinkEntity, {
          organizationId: orgId,
          guardianMembershipId: dto.guardianMembershipId,
          studentMembershipId: dto.studentMembershipId,
          relationship,
          isPrimary,
          createdBy: actorId,
          updatedBy: actorId,
        }),
      );
    });
    this.logger.log(
      `Guardian ${dto.guardianMembershipId} linked to student ${dto.studentMembershipId} (link ${saved.id})`,
    );
    return this.toLinkView(saved);
  }

  /** Soft-unlink (never a delete — consent history keeps resolving). */
  async unlinkGuardian(
    orgId: string,
    linkId: string,
    actorId: string,
  ): Promise<GuardianLinkView> {
    const row = await this.requireLink(orgId, linkId);
    if (row.deactivatedAt === null) {
      row.deactivatedAt = new Date();
      row.isPrimary = false;
      row.updatedBy = actorId;
      await this.links.save(row);
      this.logger.log(`Guardian link ${linkId} unlinked for org ${orgId}`);
    }
    return this.toLinkView(row);
  }

  /** Active links FOR a student (its guardians). */
  async listGuardiansOf(
    orgId: string,
    studentMembershipId: string,
  ): Promise<GuardianLinkView[]> {
    const rows = await this.links.find({
      where: {
        organizationId: orgId,
        studentMembershipId,
        deactivatedAt: IsNull(),
      },
      order: { isPrimary: 'DESC', createdAt: 'ASC' },
    });
    return rows.map((r) => this.toLinkView(r));
  }

  /** Active links FOR a guardian (their students/wards). */
  async listStudentsOf(
    orgId: string,
    guardianMembershipId: string,
  ): Promise<GuardianLinkView[]> {
    const rows = await this.links.find({
      where: {
        organizationId: orgId,
        guardianMembershipId,
        deactivatedAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.toLinkView(r));
  }

  // ── consent ledger ───────────────────────────────────────────────────────

  /**
   * Record a consent (append-only). `grantedByMembershipId` must be either the
   * subject themselves (self-consent) or a guardian ACTIVELY linked to the
   * subject (guardian-consent). Idempotent: an already-active identical consent
   * is returned unchanged rather than duplicated.
   */
  async recordConsent(
    orgId: string,
    dto: RecordConsentDto,
    actorId: string,
  ): Promise<ConsentView> {
    await this.assertMembershipInOrg(orgId, dto.subjectMembershipId);
    const grantedBy = dto.grantedByMembershipId ?? dto.subjectMembershipId;
    const basis = await this.resolveConsentBasis(
      orgId,
      dto.subjectMembershipId,
      grantedBy,
    );

    const active = await this.findActiveConsent(
      orgId,
      dto.subjectMembershipId,
      dto.purpose,
    );
    if (active) return this.toConsentView(active); // idempotent

    const saved = await this.consents.save(
      this.consents.create({
        organizationId: orgId,
        subjectMembershipId: dto.subjectMembershipId,
        purpose: dto.purpose.trim(),
        basis,
        grantedByMembershipId: grantedBy,
        grantedAt: new Date(),
        version: dto.version ?? 1,
        createdBy: actorId,
      }),
    );
    this.logger.log(
      `Consent '${saved.purpose}' recorded for learner ${dto.subjectMembershipId} (basis ${basis})`,
    );
    return this.toConsentView(saved);
  }

  /** Revoke consent — soft-stamps every active record for (subject, purpose). */
  async revokeConsent(
    orgId: string,
    dto: RevokeConsentDto,
    actorId: string,
  ): Promise<{ revoked: number }> {
    await this.assertMembershipInOrg(orgId, dto.subjectMembershipId);
    const active = await this.consents.find({
      where: {
        organizationId: orgId,
        subjectMembershipId: dto.subjectMembershipId,
        purpose: dto.purpose.trim(),
        revokedAt: IsNull(),
      },
    });
    if (active.length === 0) return { revoked: 0 };
    const now = new Date();
    for (const row of active) {
      row.revokedAt = now;
      row.revokedByMembershipId = dto.revokedByMembershipId ?? null;
    }
    await this.consents.save(active);
    this.logger.log(
      `Revoked ${active.length} consent(s) '${dto.purpose}' for learner ${dto.subjectMembershipId}`,
    );
    return { revoked: active.length };
  }

  /** Is `purpose` currently consented for learner `subjectMembershipId`? */
  async isConsented(
    orgId: string,
    subjectMembershipId: string,
    purpose: string,
  ): Promise<boolean> {
    const active = await this.findActiveConsent(
      orgId,
      subjectMembershipId,
      purpose.trim(),
    );
    return !!active;
  }

  /** Full ledger for a learner (active + revoked), newest first. */
  async listConsent(
    orgId: string,
    subjectMembershipId: string,
  ): Promise<ConsentView[]> {
    const rows = await this.consents.find({
      where: { organizationId: orgId, subjectMembershipId },
      order: { grantedAt: 'DESC' },
    });
    return rows.map((r) => this.toConsentView(r));
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async requireLink(
    orgId: string,
    id: string,
  ): Promise<GuardianLinkEntity> {
    const row = await this.links.findOne({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Guardian link not found');
    return row;
  }

  /** The membership must exist in this org AND be of the required personType. */
  private async assertPersonType(
    orgId: string,
    membershipId: string,
    personType: 'guardian' | 'student',
  ): Promise<OrgMembershipEntity> {
    const member = await this.assertMembershipInOrg(orgId, membershipId);
    if (member.personType !== personType) {
      throw new BadRequestException(
        `${membershipId} must be a ${personType} membership (got personType='${member.personType}')`,
      );
    }
    return member;
  }

  private async assertMembershipInOrg(
    orgId: string,
    membershipId: string,
  ): Promise<OrgMembershipEntity> {
    const member = await this.memberships.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!member) {
      throw new BadRequestException(
        `${membershipId} is not a member of this organization`,
      );
    }
    return member;
  }

  /**
   * Decide (and authorize) the consent basis. Self-consent: the grantor IS the
   * subject. Guardian-consent: the grantor must be a guardian ACTIVELY linked to
   * the subject — otherwise a stranger could consent on a learner's behalf.
   */
  private async resolveConsentBasis(
    orgId: string,
    subjectMembershipId: string,
    grantedByMembershipId: string,
  ): Promise<ConsentBasis> {
    if (grantedByMembershipId === subjectMembershipId) return 'self';
    const link = await this.links.findOne({
      where: {
        organizationId: orgId,
        guardianMembershipId: grantedByMembershipId,
        studentMembershipId: subjectMembershipId,
        deactivatedAt: IsNull(),
      },
    });
    if (!link) {
      throw new BadRequestException(
        'grantedByMembershipId must be the learner (self-consent) or a linked guardian',
      );
    }
    return 'guardian';
  }

  private async findActiveConsent(
    orgId: string,
    subjectMembershipId: string,
    purpose: string,
  ): Promise<ConsentLedgerEntity | null> {
    return this.consents.findOne({
      where: {
        organizationId: orgId,
        subjectMembershipId,
        purpose,
        revokedAt: IsNull(),
      },
    });
  }

  /** Clear `isPrimary` on every active link for a student (one primary max). */
  private async clearPrimaryInTx(
    tx: EntityManager,
    orgId: string,
    studentMembershipId: string,
  ): Promise<void> {
    await tx.update(
      GuardianLinkEntity,
      {
        organizationId: orgId,
        studentMembershipId,
        deactivatedAt: IsNull(),
        isPrimary: true,
      },
      { isPrimary: false },
    );
  }

  private toLinkView(row: GuardianLinkEntity): GuardianLinkView {
    return {
      id: row.id,
      organizationId: row.organizationId,
      guardianMembershipId: row.guardianMembershipId,
      studentMembershipId: row.studentMembershipId,
      relationship: row.relationship,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toConsentView(row: ConsentLedgerEntity): ConsentView {
    return {
      id: row.id,
      subjectMembershipId: row.subjectMembershipId,
      purpose: row.purpose,
      basis: row.basis,
      grantedByMembershipId: row.grantedByMembershipId,
      grantedAt: row.grantedAt,
      revokedAt: row.revokedAt ?? null,
      version: row.version,
      active: !row.revokedAt,
    };
  }
}
