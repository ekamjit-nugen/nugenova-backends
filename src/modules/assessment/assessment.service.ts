import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AssessmentEntity, AssessmentType } from './entities/assessment.entity';
import { MarkEntity } from './entities/mark.entity';
import { ClassSectionEntity } from '../lms/entities/class-section.entity';
import { EnrolmentEntity } from '../lms/entities/enrolment.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { staffScope } from '../auth/entities/person-type';
import {
  CreateAssessmentDto,
  RecordMarkDto,
  UpdateAssessmentDto,
} from './dto';

export interface AssessmentView {
  id: string;
  organizationId: string;
  classSectionId: string;
  termId: string;
  title: string;
  type: AssessmentType;
  maxMarks: number;
  weight: number;
  dueDate: Date | null;
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MarkView {
  id: string;
  assessmentId: string;
  enrolmentId: string;
  studentMembershipId: string;
  marksObtained: number | null;
  gradedBy: string | null;
  gradedAt: Date | null;
  remark: string | null;
}

/** One student's score on one assessment, within a gradebook/report. */
export interface GradebookCell {
  assessmentId: string;
  markId: string | null;
  marksObtained: number | null;
  percentage: number | null;
  remark: string | null;
}

/** A rolled-up total for a student across the class's assessments. */
export interface WeightedSummary {
  /** Weighted % over GRADED assessments only (0 when nothing is graded). */
  weightedPercentage: number;
  totalObtained: number;
  totalMax: number;
  gradedCount: number;
}

export interface GradebookRow extends WeightedSummary {
  enrolmentId: string;
  studentMembershipId: string;
  userId: string | null;
  name: string | null;
  email: string | null;
  cells: GradebookCell[];
}

export interface Gradebook {
  classSectionId: string;
  assessments: AssessmentView[];
  rows: GradebookRow[];
}

export interface StudentReportEntry {
  assessment: AssessmentView;
  marksObtained: number | null;
  percentage: number | null;
  remark: string | null;
}

export interface StudentReport extends WeightedSummary {
  enrolmentId: string;
  studentMembershipId: string;
  userId: string | null;
  name: string | null;
  email: string | null;
  entries: StudentReportEntry[];
}

/** The caller identity the read authorization needs (from the JWT). */
export interface Caller {
  userId: string;
  orgRole: string;
}

/**
 * AssessmentService — the GRADEBOOK layer. Sits on the lms roster
 * (`class_sections` + `enrolments`) and, through the class, on the academic
 * calendar. Every method takes `orgId` from the JWT (never the client) and
 * filters on it, so one org can never read or mutate another's gradebook
 * (cross-org lookups surface as 404).
 *
 * Invariants enforced here (indexes back the unique one so a race can't break it):
 *
 *  - An assessment's `termId` is DERIVED from its class — it can never disagree
 *    with the class's calendar.
 *  - A mark's enrolment MUST belong to the assessment's class, be tenant-scoped,
 *    and be `status='enrolled'` — withdrawn/completed students can't be graded.
 *  - The graded subject MUST be a STUDENT membership (personType='student') —
 *    the `staffScope` guard the OTHER way round; staff never enter the gradebook.
 *  - UNIQUE (assessment, enrolment): a re-grade FLIPS THE SAME mark row (mirrors
 *    the lms "re-enrol on the same row" pattern), never a duplicate.
 *  - `marksObtained`, when not null, is within [0, maxMarks].
 */
@Injectable()
export class AssessmentService {
  private readonly logger = new Logger(AssessmentService.name);

  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessments: Repository<AssessmentEntity>,
    @InjectRepository(MarkEntity)
    private readonly marks: Repository<MarkEntity>,
    @InjectRepository(ClassSectionEntity)
    private readonly classes: Repository<ClassSectionEntity>,
    @InjectRepository(EnrolmentEntity)
    private readonly enrolments: Repository<EnrolmentEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  // ── assessments (CRUD) ────────────────────────────────────────────────────────

  async createAssessment(
    orgId: string,
    classSectionId: string,
    dto: CreateAssessmentDto,
    actorId: string,
  ): Promise<AssessmentView> {
    // The class must exist in THIS org; its term anchors the assessment's calendar.
    const klass = await this.requireClass(orgId, classSectionId);

    const row = await this.assessments.save(
      this.assessments.create({
        organizationId: orgId,
        classSectionId: klass.id,
        // Derived from the class — never taken from the client, so an assessment
        // can't be pinned to a term the class doesn't run in.
        termId: klass.termId,
        title: dto.title.trim(),
        type: dto.type,
        maxMarks: dto.maxMarks,
        weight: dto.weight ?? 1,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        published: dto.published ?? false,
        createdBy: actorId,
        updatedBy: actorId,
      }),
    );
    this.logger.log(
      `Assessment '${row.title}' (${row.id}) created for class ${classSectionId}`,
    );
    return this.toAssessmentView(row);
  }

  async listAssessments(
    orgId: string,
    classSectionId: string,
  ): Promise<AssessmentView[]> {
    await this.requireClass(orgId, classSectionId);
    const rows = await this.assessments.find({
      where: { organizationId: orgId, classSectionId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.toAssessmentView(r));
  }

  async getAssessment(orgId: string, id: string): Promise<AssessmentView> {
    return this.toAssessmentView(await this.requireAssessment(orgId, id));
  }

  async updateAssessment(
    orgId: string,
    id: string,
    dto: UpdateAssessmentDto,
    actorId: string,
  ): Promise<AssessmentView> {
    const row = await this.requireAssessment(orgId, id);

    if (dto.title !== undefined) row.title = dto.title.trim();
    if (dto.type !== undefined) row.type = dto.type;
    if (dto.maxMarks !== undefined) row.maxMarks = dto.maxMarks;
    if (dto.weight !== undefined) row.weight = dto.weight;
    if (dto.dueDate !== undefined) {
      row.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    }
    if (dto.published !== undefined) row.published = dto.published;
    row.updatedBy = actorId;

    return this.toAssessmentView(await this.assessments.save(row));
  }

  /** Delete an assessment — cascades to its marks (the cells are meaningless without it). */
  async removeAssessment(orgId: string, id: string): Promise<void> {
    const row = await this.requireAssessment(orgId, id);
    await this.marks.delete({ assessmentId: row.id, organizationId: orgId });
    await this.assessments.delete({ id: row.id, organizationId: orgId });
    this.logger.log(`Assessment '${row.title}' (${id}) deleted for org ${orgId}`);
  }

  // ── marks ─────────────────────────────────────────────────────────────────────

  /**
   * Record or re-grade one student's mark. Upserts by (assessmentId, enrolmentId):
   * an existing row is updated in place (never duplicated), a fresh one is created.
   * The enrolment must belong to the assessment's class, be tenant-scoped and
   * actively enrolled, and its member must be a STUDENT.
   */
  async recordMark(
    orgId: string,
    assessmentId: string,
    dto: RecordMarkDto,
    actorId: string,
  ): Promise<MarkView> {
    const assessment = await this.requireAssessment(orgId, assessmentId);
    const enrolment = await this.requireEnrolmentForClass(
      orgId,
      assessment.classSectionId,
      dto.enrolmentId,
    );
    if (enrolment.status !== 'enrolled') {
      throw new BadRequestException(
        `Only actively-enrolled students can be graded (enrolment status='${enrolment.status}')`,
      );
    }
    // The personType guard, the OTHER way round: only students are graded.
    await this.assertMembershipIsStudent(orgId, enrolment.studentMembershipId);

    const marksObtained =
      dto.marksObtained === undefined ? null : dto.marksObtained;
    if (marksObtained !== null) {
      const max = Number(assessment.maxMarks);
      if (marksObtained < 0 || marksObtained > max) {
        throw new BadRequestException(
          `marksObtained ${marksObtained} is out of range [0, ${max}]`,
        );
      }
    }

    const existing = await this.marks.findOne({
      where: { assessmentId: assessment.id, enrolmentId: enrolment.id },
    });

    const now = new Date();
    let saved: MarkEntity;
    if (existing) {
      // Re-grade FLIPS THE SAME ROW (respects the (assessment, enrolment) unique index).
      existing.marksObtained = marksObtained;
      existing.remark = dto.remark ?? existing.remark ?? null;
      existing.gradedBy = actorId;
      existing.gradedAt = marksObtained === null ? null : now;
      saved = await this.marks.save(existing);
    } else {
      saved = await this.marks.save(
        this.marks.create({
          organizationId: orgId,
          assessmentId: assessment.id,
          enrolmentId: enrolment.id,
          // Denormalized from the enrolment — pins the student identity at grade time.
          studentMembershipId: enrolment.studentMembershipId,
          marksObtained,
          remark: dto.remark ?? null,
          gradedBy: actorId,
          gradedAt: marksObtained === null ? null : now,
        }),
      );
    }
    this.logger.log(
      `Mark ${saved.id} recorded on assessment ${assessment.id} for enrolment ${enrolment.id}`,
    );
    return this.toMarkView(saved);
  }

  // ── gradebook + student report ─────────────────────────────────────────────────

  /**
   * The class gradebook — the roster (actively-enrolled students) × assessments
   * matrix, each student's cells plus a weighted total. Access: owner/admin OR the
   * class's assigned teacher (mirrors the lms roster).
   */
  async gradebook(
    orgId: string,
    classSectionId: string,
    caller: Caller,
  ): Promise<Gradebook> {
    const klass = await this.requireClass(orgId, classSectionId);
    await this.assertClassReadAccess(orgId, klass, caller);

    const assessments = await this.assessments.find({
      where: { organizationId: orgId, classSectionId },
      order: { createdAt: 'ASC' },
    });
    const roster = await this.rosterEntries(orgId, classSectionId);
    if (roster.length === 0) {
      return { classSectionId, assessments: assessments.map((a) => this.toAssessmentView(a)), rows: [] };
    }

    // Marks for these enrolments only, indexed by enrolment → assessment.
    const enrolmentIds = roster.map((r) => r.enrolmentId);
    const markRows = assessments.length
      ? await this.marks.find({
          where: {
            organizationId: orgId,
            assessmentId: In(assessments.map((a) => a.id)),
            enrolmentId: In(enrolmentIds),
          },
        })
      : [];
    const markByEnrolAssessment = new Map<string, MarkEntity>();
    for (const m of markRows) {
      markByEnrolAssessment.set(`${m.enrolmentId}:${m.assessmentId}`, m);
    }

    const rows: GradebookRow[] = roster.map((r) => {
      const cells: GradebookCell[] = assessments.map((a) => {
        const m = markByEnrolAssessment.get(`${r.enrolmentId}:${a.id}`);
        return this.toCell(a, m);
      });
      const summary = this.summarize(assessments, (a) =>
        markByEnrolAssessment.get(`${r.enrolmentId}:${a.id}`),
      );
      return { ...r, cells, ...summary };
    });

    return {
      classSectionId,
      assessments: assessments.map((a) => this.toAssessmentView(a)),
      rows,
    };
  }

  /**
   * One student's report — their marks across the class's assessments plus their
   * overall weighted total. Access: owner/admin OR the class's assigned teacher.
   */
  async studentReport(
    orgId: string,
    enrolmentId: string,
    caller: Caller,
  ): Promise<StudentReport> {
    const enrolment = await this.requireEnrolment(orgId, enrolmentId);
    const klass = await this.requireClass(orgId, enrolment.classId);
    await this.assertClassReadAccess(orgId, klass, caller);

    const assessments = await this.assessments.find({
      where: { organizationId: orgId, classSectionId: klass.id },
      order: { createdAt: 'ASC' },
    });
    const markRows = assessments.length
      ? await this.marks.find({
          where: {
            organizationId: orgId,
            enrolmentId: enrolment.id,
            assessmentId: In(assessments.map((a) => a.id)),
          },
        })
      : [];
    const markByAssessment = new Map(markRows.map((m) => [m.assessmentId, m]));

    const display = await this.displayFor(orgId, [
      enrolment.studentMembershipId,
    ]);
    const d = display.get(enrolment.studentMembershipId);

    const entries: StudentReportEntry[] = assessments.map((a) => {
      const m = markByAssessment.get(a.id);
      const cell = this.toCell(a, m);
      return {
        assessment: this.toAssessmentView(a),
        marksObtained: cell.marksObtained,
        percentage: cell.percentage,
        remark: cell.remark,
      };
    });
    const summary = this.summarize(assessments, (a) => markByAssessment.get(a.id));

    return {
      enrolmentId: enrolment.id,
      studentMembershipId: enrolment.studentMembershipId,
      userId: d?.userId ?? null,
      name: d?.name ?? null,
      email: d?.email ?? null,
      entries,
      ...summary,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async requireClass(
    orgId: string,
    id: string,
  ): Promise<ClassSectionEntity> {
    const row = await this.classes.findOne({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Class not found');
    return row;
  }

  private async requireAssessment(
    orgId: string,
    id: string,
  ): Promise<AssessmentEntity> {
    const row = await this.assessments.findOne({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Assessment not found');
    return row;
  }

  private async requireEnrolment(
    orgId: string,
    id: string,
  ): Promise<EnrolmentEntity> {
    const row = await this.enrolments.findOne({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Enrolment not found');
    return row;
  }

  private async requireEnrolmentForClass(
    orgId: string,
    classId: string,
    enrolmentId: string,
  ): Promise<EnrolmentEntity> {
    const row = await this.enrolments.findOne({
      where: { id: enrolmentId, classId, organizationId: orgId },
    });
    if (!row) {
      throw new NotFoundException('Enrolment not found for this class');
    }
    return row;
  }

  /** A graded subject MUST be a STUDENT membership in this org (staff/guardian → 400). */
  private async assertMembershipIsStudent(
    orgId: string,
    membershipId: string,
  ): Promise<void> {
    const member = await this.memberships.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!member) {
      throw new BadRequestException(
        'studentMembershipId must reference a member of this organization',
      );
    }
    if (member.personType !== 'student') {
      throw new BadRequestException(
        `Only student memberships can be graded (got personType='${member.personType}')`,
      );
    }
  }

  private async assertClassReadAccess(
    orgId: string,
    klass: ClassSectionEntity,
    caller: Caller,
  ): Promise<void> {
    if (caller.orgRole === 'owner' || caller.orgRole === 'admin') return;
    if (klass.teacherMembershipId) {
      const mine = await this.memberships.findOne({
        where: staffScope({ userId: caller.userId, organizationId: orgId }),
      });
      if (mine && mine.id === klass.teacherMembershipId) return;
    }
    throw new ForbiddenException(
      'Only the class teacher or an organization admin can view this gradebook',
    );
  }

  /** Actively-enrolled roster entries with display info (student-only, like lms.roster). */
  private async rosterEntries(
    orgId: string,
    classSectionId: string,
  ): Promise<
    Array<{
      enrolmentId: string;
      studentMembershipId: string;
      userId: string | null;
      name: string | null;
      email: string | null;
    }>
  > {
    const rows = await this.enrolments.find({
      where: { organizationId: orgId, classId: classSectionId, status: 'enrolled' },
      order: { enrolledAt: 'ASC' },
    });
    if (rows.length === 0) return [];
    const display = await this.displayFor(
      orgId,
      rows.map((r) => r.studentMembershipId),
    );
    return rows.map((r) => {
      const d = display.get(r.studentMembershipId);
      return {
        enrolmentId: r.id,
        studentMembershipId: r.studentMembershipId,
        userId: d?.userId ?? null,
        name: d?.name ?? null,
        email: d?.email ?? null,
      };
    });
  }

  /** Resolve student memberships → display (name/email), student-scoped only. */
  private async displayFor(
    orgId: string,
    membershipIds: string[],
  ): Promise<
    Map<string, { userId: string | null; name: string | null; email: string | null }>
  > {
    const out = new Map<
      string,
      { userId: string | null; name: string | null; email: string | null }
    >();
    if (membershipIds.length === 0) return out;
    const members = await this.memberships.find({
      where: {
        id: In(membershipIds),
        organizationId: orgId,
        personType: 'student',
      },
    });
    const userIds = members
      .map((m) => m.userId)
      .filter((u): u is string => !!u);
    const users = userIds.length
      ? await this.users.find({ where: { id: In(userIds) } })
      : [];
    const byUserId = new Map(users.map((u) => [u.id, u]));
    for (const m of members) {
      const user = m.userId ? byUserId.get(m.userId) : undefined;
      const name = user
        ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null
        : null;
      out.set(m.id, {
        userId: m.userId ?? null,
        name,
        email: m.email ?? user?.email ?? null,
      });
    }
    return out;
  }

  private toCell(a: AssessmentEntity, m?: MarkEntity): GradebookCell {
    const obtained =
      m && m.marksObtained !== null && m.marksObtained !== undefined
        ? Number(m.marksObtained)
        : null;
    const max = Number(a.maxMarks);
    const percentage =
      obtained !== null && max > 0 ? round2((obtained / max) * 100) : null;
    return {
      assessmentId: a.id,
      markId: m?.id ?? null,
      marksObtained: obtained,
      percentage,
      remark: m?.remark ?? null,
    };
  }

  /**
   * Weighted total across GRADED assessments only. Each graded assessment
   * contributes `weight × (obtained / maxMarks)`; the weighted % normalises by the
   * summed weight of the graded assessments, so an ungraded item neither helps nor
   * hurts. Also returns the raw points total for a simple denominator view.
   */
  private summarize(
    assessments: AssessmentEntity[],
    markOf: (a: AssessmentEntity) => MarkEntity | undefined,
  ): WeightedSummary {
    let weightNumer = 0;
    let weightDenom = 0;
    let totalObtained = 0;
    let totalMax = 0;
    let gradedCount = 0;
    for (const a of assessments) {
      const m = markOf(a);
      if (!m || m.marksObtained === null || m.marksObtained === undefined) {
        continue;
      }
      const max = Number(a.maxMarks);
      const obtained = Number(m.marksObtained);
      const weight = Number(a.weight);
      if (max > 0) {
        weightNumer += weight * (obtained / max);
        weightDenom += weight;
      }
      totalObtained += obtained;
      totalMax += max;
      gradedCount += 1;
    }
    const weightedPercentage =
      weightDenom > 0 ? round2((weightNumer / weightDenom) * 100) : 0;
    return {
      weightedPercentage,
      totalObtained: round2(totalObtained),
      totalMax: round2(totalMax),
      gradedCount,
    };
  }

  private toAssessmentView(row: AssessmentEntity): AssessmentView {
    return {
      id: row.id,
      organizationId: row.organizationId,
      classSectionId: row.classSectionId,
      termId: row.termId,
      title: row.title,
      type: row.type,
      maxMarks: Number(row.maxMarks),
      weight: Number(row.weight),
      dueDate: row.dueDate,
      published: row.published,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toMarkView(row: MarkEntity): MarkView {
    return {
      id: row.id,
      assessmentId: row.assessmentId,
      enrolmentId: row.enrolmentId,
      studentMembershipId: row.studentMembershipId,
      marksObtained:
        row.marksObtained === null || row.marksObtained === undefined
          ? null
          : Number(row.marksObtained),
      gradedBy: row.gradedBy,
      gradedAt: row.gradedAt,
      remark: row.remark,
    };
  }
}

/** Round to 2 decimals (marks/percentages are display values, not money). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
