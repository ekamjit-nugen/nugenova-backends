import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { DomainEventsService } from '../platform-events/domain-events.service';
import { DOMAIN_EVENTS } from '../platform-events/domain-events';
import { CourseEntity } from './entities/course.entity';
import { ClassSectionEntity } from './entities/class-section.entity';
import { EnrolmentEntity } from './entities/enrolment.entity';
import { TermEntity } from '../academic/entities/term.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { staffScope } from '../auth/entities/person-type';
import {
  CreateClassDto,
  CreateCourseDto,
  EnrolStudentDto,
  UpdateClassDto,
  UpdateCourseDto,
} from './dto';

export interface CourseView {
  id: string;
  organizationId: string;
  academicYearId: string | null;
  code: string;
  name: string;
  description: string | null;
  subject: string | null;
  credits: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClassView {
  id: string;
  organizationId: string;
  courseId: string;
  termId: string;
  section: string;
  teacherMembershipId: string | null;
  capacity: number | null;
  isActive: boolean;
  enrolledCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnrolmentView {
  id: string;
  classId: string;
  studentMembershipId: string;
  status: string;
  enrolledAt: Date;
  withdrawnAt: Date | null;
  completedAt: Date | null;
}

export interface RosterEntry {
  enrolmentId: string;
  studentMembershipId: string;
  userId: string | null;
  name: string | null;
  email: string | null;
  enrolledAt: Date;
}

/** The caller identity the roster authorization needs (from the JWT). */
export interface Caller {
  userId: string;
  orgRole: string;
}

/**
 * LmsService — the academic STRUCTURE + ENROLMENT layer that sits on the
 * academic calendar. Every method takes `orgId` from the JWT (never the client)
 * and filters on it, so one org can never read or mutate another's LMS data
 * (cross-org lookups surface as 404).
 *
 * Invariants enforced here (and backed by DB indexes so a race can't break them):
 *
 *  - Course `code` is UNIQUE per org among ACTIVE courses (partial-unique index +
 *    a pre-check); archiving a course frees its code.
 *  - A class/section is UNIQUE per (course, term, section).
 *  - A class teacher MUST be a STAFF membership — a student can't teach
 *    (`assertTeacherIsStaff`, personType='staff').
 *  - An enrolment's membership MUST be a STUDENT — staff/guardian are rejected
 *    400 (`assertMembershipIsStudent`, personType='student').
 *  - UNIQUE (class, student): no double-enrolment. Withdraw is a soft status
 *    transition; a later re-enrol flips the same row back to 'enrolled'.
 *  - `capacity`, when set, caps ACTIVE enrolments — enforced under a pessimistic
 *    row lock on the class so concurrent enrolments can't overfill it.
 */
@Injectable()
export class LmsService {
  private readonly logger = new Logger(LmsService.name);

  constructor(
    @InjectRepository(CourseEntity)
    private readonly courses: Repository<CourseEntity>,
    @InjectRepository(ClassSectionEntity)
    private readonly classes: Repository<ClassSectionEntity>,
    @InjectRepository(EnrolmentEntity)
    private readonly enrolments: Repository<EnrolmentEntity>,
    @InjectRepository(TermEntity)
    private readonly terms: Repository<TermEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    // §08 layer-1 proof point: emit `enrolment.created`. @Optional so the DB-less
    // unit spec (which provides no bus) still constructs the service; the booted
    // app always has the global PlatformEventsModule provider.
    @Optional() private readonly events?: DomainEventsService,
  ) {}

  // ── courses ─────────────────────────────────────────────────────────────────

  async createCourse(
    orgId: string,
    dto: CreateCourseDto,
    actorId: string,
  ): Promise<CourseView> {
    const code = dto.code.trim();
    await this.assertCodeFree(orgId, code, null);

    const row = await this.courses.save(
      this.courses.create({
        organizationId: orgId,
        academicYearId: dto.academicYearId ?? null,
        code,
        name: dto.name.trim(),
        description: dto.description ?? null,
        subject: dto.subject ?? null,
        credits: dto.credits ?? null,
        isActive: dto.isActive ?? true,
        createdBy: actorId,
        updatedBy: actorId,
      }),
    );
    this.logger.log(`Course '${code}' (${row.id}) created for org ${orgId}`);
    return this.toCourseView(row);
  }

  async listCourses(orgId: string): Promise<CourseView[]> {
    const rows = await this.courses.find({
      where: { organizationId: orgId },
      order: { code: 'ASC' },
    });
    return rows.map((r) => this.toCourseView(r));
  }

  async getCourse(orgId: string, id: string): Promise<CourseView> {
    return this.toCourseView(await this.requireCourse(orgId, id));
  }

  async updateCourse(
    orgId: string,
    id: string,
    dto: UpdateCourseDto,
    actorId: string,
  ): Promise<CourseView> {
    const row = await this.requireCourse(orgId, id);
    const willBeActive = dto.isActive ?? row.isActive;

    if (dto.code !== undefined) {
      const code = dto.code.trim();
      if (code !== row.code || willBeActive) {
        // Only ACTIVE courses contend for a code; re-check when code changes or
        // the course is (re)activated.
        await this.assertCodeFree(orgId, code, row.id, willBeActive);
      }
      row.code = code;
    } else if (dto.isActive === true && !row.isActive) {
      // Re-activating: make sure its code isn't now taken by another active course.
      await this.assertCodeFree(orgId, row.code, row.id, true);
    }

    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.academicYearId !== undefined)
      row.academicYearId = dto.academicYearId ?? null;
    if (dto.description !== undefined) row.description = dto.description ?? null;
    if (dto.subject !== undefined) row.subject = dto.subject ?? null;
    if (dto.credits !== undefined) row.credits = dto.credits ?? null;
    if (dto.isActive !== undefined) row.isActive = dto.isActive;
    row.updatedBy = actorId;

    return this.toCourseView(await this.courses.save(row));
  }

  /** Delete a course — refused while any class/section still references it. */
  async removeCourse(orgId: string, id: string): Promise<void> {
    const row = await this.requireCourse(orgId, id);
    const classCount = await this.classes.count({
      where: { organizationId: orgId, courseId: row.id },
    });
    if (classCount > 0) {
      throw new BadRequestException(
        'Course has class/sections — archive it (isActive=false) instead of deleting',
      );
    }
    await this.courses.delete({ id: row.id, organizationId: orgId });
    this.logger.log(`Course '${row.code}' (${id}) deleted for org ${orgId}`);
  }

  // ── classes / sections ────────────────────────────────────────────────────────

  async createClass(
    orgId: string,
    dto: CreateClassDto,
    actorId: string,
  ): Promise<ClassView> {
    await this.requireCourse(orgId, dto.courseId);
    await this.requireTerm(orgId, dto.termId);
    const section = dto.section.trim();

    if (dto.teacherMembershipId) {
      await this.assertTeacherIsStaff(orgId, dto.teacherMembershipId);
    }

    const clash = await this.classes.findOne({
      where: {
        organizationId: orgId,
        courseId: dto.courseId,
        termId: dto.termId,
        section,
      },
    });
    if (clash) {
      throw new BadRequestException(
        `A section '${section}' already exists for this course and term`,
      );
    }

    const row = await this.classes.save(
      this.classes.create({
        organizationId: orgId,
        courseId: dto.courseId,
        termId: dto.termId,
        section,
        teacherMembershipId: dto.teacherMembershipId ?? null,
        capacity: dto.capacity ?? null,
        isActive: dto.isActive ?? true,
        createdBy: actorId,
        updatedBy: actorId,
      }),
    );
    this.logger.log(
      `Class '${section}' (${row.id}) created for course ${dto.courseId}/term ${dto.termId}`,
    );
    return this.toClassView(row, 0);
  }

  async listClasses(
    orgId: string,
    filter: { courseId?: string; termId?: string } = {},
  ): Promise<ClassView[]> {
    const where: Record<string, string> = { organizationId: orgId };
    if (filter.courseId) where.courseId = filter.courseId;
    if (filter.termId) where.termId = filter.termId;
    const rows = await this.classes.find({
      where,
      order: { createdAt: 'ASC' },
    });
    const counts = await this.activeCountsByClass(rows.map((r) => r.id));
    return rows.map((r) => this.toClassView(r, counts.get(r.id) ?? 0));
  }

  async getClass(orgId: string, id: string): Promise<ClassView> {
    const row = await this.requireClass(orgId, id);
    return this.toClassView(row, await this.countActiveEnrolments(row.id));
  }

  async updateClass(
    orgId: string,
    id: string,
    dto: UpdateClassDto,
    actorId: string,
  ): Promise<ClassView> {
    const row = await this.requireClass(orgId, id);

    if (dto.teacherMembershipId !== undefined) {
      if (dto.teacherMembershipId) {
        await this.assertTeacherIsStaff(orgId, dto.teacherMembershipId);
        row.teacherMembershipId = dto.teacherMembershipId;
      } else {
        row.teacherMembershipId = null;
      }
    }

    if (dto.section !== undefined) {
      const section = dto.section.trim();
      if (section !== row.section) {
        const clash = await this.classes.findOne({
          where: {
            organizationId: orgId,
            courseId: row.courseId,
            termId: row.termId,
            section,
          },
        });
        if (clash && clash.id !== row.id) {
          throw new BadRequestException(
            `A section '${section}' already exists for this course and term`,
          );
        }
        row.section = section;
      }
    }

    if (dto.capacity !== undefined) {
      if (dto.capacity !== null) {
        const active = await this.countActiveEnrolments(row.id);
        if (dto.capacity < active) {
          throw new BadRequestException(
            `Capacity ${dto.capacity} is below the ${active} students already enrolled`,
          );
        }
      }
      row.capacity = dto.capacity;
    }

    if (dto.isActive !== undefined) row.isActive = dto.isActive;
    row.updatedBy = actorId;

    const saved = await this.classes.save(row);
    return this.toClassView(saved, await this.countActiveEnrolments(saved.id));
  }

  /** Delete a class — refused while any enrolment (of any status) references it. */
  async removeClass(orgId: string, id: string): Promise<void> {
    const row = await this.requireClass(orgId, id);
    const enrolCount = await this.enrolments.count({
      where: { organizationId: orgId, classId: row.id },
    });
    if (enrolCount > 0) {
      throw new BadRequestException(
        'Class has enrolments — deactivate it (isActive=false) instead of deleting',
      );
    }
    await this.classes.delete({ id: row.id, organizationId: orgId });
    this.logger.log(`Class '${row.section}' (${id}) deleted for org ${orgId}`);
  }

  // ── enrolments ────────────────────────────────────────────────────────────────

  async enrol(
    orgId: string,
    classId: string,
    dto: EnrolStudentDto,
    actorId: string,
  ): Promise<EnrolmentView> {
    const klass = await this.requireClass(orgId, classId);
    if (!klass.isActive) {
      throw new BadRequestException('Cannot enrol into an inactive class');
    }
    // The personType guard, the OTHER way round: only students enrol.
    await this.assertMembershipIsStudent(orgId, dto.studentMembershipId);

    let wasNew = false;
    const saved = await this.enrolments.manager.transaction(async (tx) => {
      // Serialize concurrent enrolments to THIS class so capacity can't be raced.
      await tx.findOne(ClassSectionEntity, {
        where: { id: klass.id },
        lock: { mode: 'pessimistic_write' },
      });

      const existing = await tx.findOne(EnrolmentEntity, {
        where: { classId: klass.id, studentMembershipId: dto.studentMembershipId },
      });
      if (existing && existing.status === 'enrolled') {
        throw new BadRequestException('Student is already enrolled in this class');
      }
      if (existing && existing.status === 'completed') {
        throw new BadRequestException(
          'Student has already completed this class',
        );
      }

      await this.assertCapacity(tx, klass);

      if (existing) {
        // Re-enrol a previously WITHDRAWN student on the SAME row (respects the
        // (class, student) unique index).
        existing.status = 'enrolled';
        existing.enrolledAt = new Date();
        existing.withdrawnAt = null;
        existing.completedAt = null;
        existing.updatedBy = actorId;
        return tx.save(EnrolmentEntity, existing);
      }

      wasNew = true;
      return tx.save(
        EnrolmentEntity,
        tx.create(EnrolmentEntity, {
          organizationId: orgId,
          classId: klass.id,
          studentMembershipId: dto.studentMembershipId,
          status: 'enrolled',
          enrolledAt: new Date(),
          createdBy: actorId,
          updatedBy: actorId,
        }),
      );
    });
    this.logger.log(
      `Student ${dto.studentMembershipId} enrolled in class ${classId} (enrolment ${saved.id})`,
    );
    // §08 layer-1: announce a fresh enrolment (re-enrol of a withdrawn row is a
    // status transition, not a new enrolment, so it does not re-fire). Emitting
    // never throws — a bus error can't fail the enrolment.
    if (wasNew) {
      this.events?.emit(DOMAIN_EVENTS.ENROLMENT_CREATED, {
        organizationId: orgId,
        enrolmentId: saved.id,
        classId: klass.id,
        studentMembershipId: dto.studentMembershipId,
        actorId,
      });
    }
    return this.toEnrolmentView(saved);
  }

  /** All enrolment rows for a class (any status) — owner/admin. */
  async listEnrolments(
    orgId: string,
    classId: string,
  ): Promise<EnrolmentView[]> {
    await this.requireClass(orgId, classId);
    const rows = await this.enrolments.find({
      where: { organizationId: orgId, classId },
      order: { enrolledAt: 'ASC' },
    });
    return rows.map((r) => this.toEnrolmentView(r));
  }

  async withdraw(
    orgId: string,
    classId: string,
    enrolmentId: string,
    actorId: string,
  ): Promise<EnrolmentView> {
    const row = await this.requireEnrolment(orgId, classId, enrolmentId);
    if (row.status === 'withdrawn') return this.toEnrolmentView(row);
    row.status = 'withdrawn';
    row.withdrawnAt = new Date();
    row.updatedBy = actorId;
    return this.toEnrolmentView(await this.enrolments.save(row));
  }

  async complete(
    orgId: string,
    classId: string,
    enrolmentId: string,
    actorId: string,
  ): Promise<EnrolmentView> {
    const row = await this.requireEnrolment(orgId, classId, enrolmentId);
    if (row.status === 'withdrawn') {
      throw new BadRequestException(
        'Cannot complete a withdrawn enrolment — re-enrol first',
      );
    }
    row.status = 'completed';
    row.completedAt = new Date();
    row.updatedBy = actorId;
    return this.toEnrolmentView(await this.enrolments.save(row));
  }

  /**
   * The student roster for a class — the legitimate student/teacher-facing read.
   * Returns ONLY actively-enrolled students (never staff, never the org
   * directory). Access: owner/admin, OR the class's assigned teacher membership.
   */
  async roster(
    orgId: string,
    classId: string,
    caller: Caller,
  ): Promise<RosterEntry[]> {
    const klass = await this.requireClass(orgId, classId);
    await this.assertRosterAccess(orgId, klass, caller);

    const rows = await this.enrolments.find({
      where: { organizationId: orgId, classId, status: 'enrolled' },
      order: { enrolledAt: 'ASC' },
    });
    if (rows.length === 0) return [];

    // Resolve student membership → user for display (email/name). Membership
    // lookups are scoped to students in this org, so a stale/foreign id yields
    // no display data rather than leaking anything.
    const membershipIds = rows.map((r) => r.studentMembershipId);
    const members = await this.memberships.find({
      where: {
        id: In(membershipIds),
        organizationId: orgId,
        personType: 'student',
      },
    });
    const byMembershipId = new Map(members.map((m) => [m.id, m]));
    const userIds = members
      .map((m) => m.userId)
      .filter((u): u is string => !!u);
    const users = userIds.length
      ? await this.users.find({ where: { id: In(userIds) } })
      : [];
    const byUserId = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) => {
      const member = byMembershipId.get(r.studentMembershipId);
      const user = member?.userId ? byUserId.get(member.userId) : undefined;
      const name = user
        ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null
        : null;
      return {
        enrolmentId: r.id,
        studentMembershipId: r.studentMembershipId,
        userId: member?.userId ?? null,
        name,
        email: member?.email ?? user?.email ?? null,
        enrolledAt: r.enrolledAt,
      };
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async requireCourse(
    orgId: string,
    id: string,
  ): Promise<CourseEntity> {
    const row = await this.courses.findOne({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Course not found');
    return row;
  }

  /** The term must exist within this org (keeps a class anchored to its own org's calendar). */
  private async requireTerm(orgId: string, termId: string): Promise<TermEntity> {
    const row = await this.terms.findOne({
      where: { id: termId, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Term not found');
    return row;
  }

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

  private async requireEnrolment(
    orgId: string,
    classId: string,
    enrolmentId: string,
  ): Promise<EnrolmentEntity> {
    const row = await this.enrolments.findOne({
      where: { id: enrolmentId, classId, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Enrolment not found');
    return row;
  }

  /** A teacher must be an active STAFF membership in this org. */
  private async assertTeacherIsStaff(
    orgId: string,
    membershipId: string,
  ): Promise<void> {
    const staff = await this.memberships.findOne({
      where: staffScope({ id: membershipId, organizationId: orgId }),
    });
    if (!staff) {
      throw new BadRequestException(
        'teacherMembershipId must reference a staff member of this organization',
      );
    }
  }

  /** An enrolee MUST be a STUDENT membership in this org (staff/guardian → 400). */
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
        `Only student memberships can be enrolled (got personType='${member.personType}')`,
      );
    }
  }

  private async assertRosterAccess(
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
      'Only the class teacher or an organization admin can view this roster',
    );
  }

  /** Throw if the class is at capacity (no-op when capacity is null). */
  private async assertCapacity(
    tx: import('typeorm').EntityManager,
    klass: ClassSectionEntity,
  ): Promise<void> {
    if (klass.capacity == null) return;
    const active = await tx.count(EnrolmentEntity, {
      where: { classId: klass.id, status: 'enrolled' },
    });
    if (active >= klass.capacity) {
      throw new BadRequestException(
        `Class is full (capacity ${klass.capacity})`,
      );
    }
  }

  private async countActiveEnrolments(classId: string): Promise<number> {
    return this.enrolments.count({ where: { classId, status: 'enrolled' } });
  }

  private async activeCountsByClass(
    classIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (classIds.length === 0) return map;
    const rows = await this.enrolments.find({
      where: { classId: In(classIds), status: 'enrolled' },
      select: ['id', 'classId'],
    });
    for (const r of rows) map.set(r.classId, (map.get(r.classId) ?? 0) + 1);
    return map;
  }

  /**
   * Ensure no OTHER active course in the org holds `code`. `checkActive` mirrors
   * the partial-unique index: a code only contends while the course is active.
   */
  private async assertCodeFree(
    orgId: string,
    code: string,
    selfId: string | null,
    checkActive = true,
  ): Promise<void> {
    if (!checkActive) return;
    const clash = await this.courses.findOne({
      where: { organizationId: orgId, code, isActive: true },
    });
    if (clash && clash.id !== selfId) {
      throw new BadRequestException(
        `Another active course already uses code '${code}'`,
      );
    }
  }

  private toCourseView(row: CourseEntity): CourseView {
    return {
      id: row.id,
      organizationId: row.organizationId,
      academicYearId: row.academicYearId,
      code: row.code,
      name: row.name,
      description: row.description,
      subject: row.subject,
      credits: row.credits,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toClassView(row: ClassSectionEntity, enrolledCount: number): ClassView {
    return {
      id: row.id,
      organizationId: row.organizationId,
      courseId: row.courseId,
      termId: row.termId,
      section: row.section,
      teacherMembershipId: row.teacherMembershipId,
      capacity: row.capacity,
      isActive: row.isActive,
      enrolledCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toEnrolmentView(row: EnrolmentEntity): EnrolmentView {
    return {
      id: row.id,
      classId: row.classId,
      studentMembershipId: row.studentMembershipId,
      status: row.status,
      enrolledAt: row.enrolledAt,
      withdrawnAt: row.withdrawnAt,
      completedAt: row.completedAt,
    };
  }
}
