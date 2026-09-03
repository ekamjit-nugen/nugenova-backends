import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { LmsService } from './lms.service';
import { CourseEntity } from './entities/course.entity';
import { ClassSectionEntity } from './entities/class-section.entity';
import { EnrolmentEntity } from './entities/enrolment.entity';
import { TermEntity } from '../academic/entities/term.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

/**
 * Pure unit specs — NO database. These pin the LMS invariants, and the enrolment
 * block is a BUILD-FAILING regression guard: it fails the build if the service
 * ever stops rejecting a non-student membership, a duplicate enrolment, or an
 * over-capacity enrolment, or stops requiring a class teacher to be staff.
 *
 * The fakes back a real in-memory `personType` on each membership, so a test only
 * passes if the service actually inspects it — delete the guard and it goes red.
 */
describe('LmsService (unit, no DB)', () => {
  let service: LmsService;
  let courses: any;
  let classes: any;
  let enrolments: any;
  let memberships: any;
  let users: any;
  let terms: any;
  let tx: any;

  const ORG = 'org1';
  const classRow = (over: Partial<ClassSectionEntity> = {}): any => ({
    id: 'c1',
    organizationId: ORG,
    courseId: 'course1',
    termId: 'term1',
    section: 'A',
    teacherMembershipId: null,
    capacity: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    tx = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn(async (_e: any, v: any) => ({ id: v.id ?? 'e1', ...v })),
      create: jest.fn((_e: any, v: any) => ({ ...v })),
    };
    const manager = { transaction: jest.fn(async (cb: any) => cb(tx)) };

    courses = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 'course1', createdAt: new Date(), updatedAt: new Date(), ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({}),
    };
    classes = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 'c1', createdAt: new Date(), updatedAt: new Date(), ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({}),
    };
    enrolments = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 'e1', ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({}),
      manager,
    };
    memberships = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    users = { find: jest.fn().mockResolvedValue([]) };
    // A class's term must exist in the org; default to a resolvable term.
    terms = { findOne: jest.fn().mockResolvedValue({ id: 'term1', organizationId: ORG }) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LmsService,
        { provide: getRepositoryToken(CourseEntity), useValue: courses },
        { provide: getRepositoryToken(ClassSectionEntity), useValue: classes },
        { provide: getRepositoryToken(EnrolmentEntity), useValue: enrolments },
        { provide: getRepositoryToken(TermEntity), useValue: terms },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: memberships },
        { provide: getRepositoryToken(UserEntity), useValue: users },
      ],
    }).compile();
    service = moduleRef.get(LmsService);
  });

  // ── course code uniqueness ─────────────────────────────────────────────────
  describe('createCourse', () => {
    it('rejects a code already used by another ACTIVE course', async () => {
      courses.findOne.mockResolvedValue({ id: 'other', code: 'MATH-101', isActive: true });
      await expect(
        service.createCourse(ORG, { code: 'MATH-101', name: 'Algebra' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates when the code is free', async () => {
      courses.findOne.mockResolvedValue(null);
      const c = await service.createCourse(ORG, { code: 'MATH-101', name: 'Algebra' }, 'admin');
      expect(c.code).toBe('MATH-101');
      expect(c.isActive).toBe(true);
    });
  });

  // ── teacher must be staff ──────────────────────────────────────────────────
  describe('createClass — teacher must be STAFF', () => {
    it('rejects a teacher membership that is not staff', async () => {
      courses.findOne.mockResolvedValue({ id: 'course1', organizationId: ORG });
      // staffScope forces personType='staff'; a non-staff id resolves to null.
      memberships.findOne.mockResolvedValue(null);
      await expect(
        service.createClass(
          ORG,
          { courseId: 'course1', termId: 'term1', section: 'A', teacherMembershipId: 'student-mem' },
          'admin',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The lookup was staff-scoped (defence in depth).
      expect(memberships.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ personType: 'staff', id: 'student-mem' }),
        }),
      );
    });

    it('accepts a staff teacher', async () => {
      courses.findOne.mockResolvedValue({ id: 'course1', organizationId: ORG });
      memberships.findOne.mockResolvedValue({ id: 'staff-mem', personType: 'staff' });
      classes.findOne.mockResolvedValue(null); // no section clash
      const k = await service.createClass(
        ORG,
        { courseId: 'course1', termId: 'term1', section: 'A', teacherMembershipId: 'staff-mem' },
        'admin',
      );
      expect(k.teacherMembershipId).toBe('staff-mem');
    });
  });

  // ── BUILD-FAILING GUARD: enrolment ─────────────────────────────────────────
  describe('guard: enrol only students, once, within capacity', () => {
    it("rejects enrolling a STAFF membership (personType != 'student')", async () => {
      classes.findOne.mockResolvedValue(classRow());
      memberships.findOne.mockResolvedValue({ id: 'm-staff', organizationId: ORG, personType: 'staff' });
      await expect(
        service.enrol(ORG, 'c1', { studentMembershipId: 'm-staff' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Never reached the enrolment transaction.
      expect(enrolments.manager.transaction).not.toHaveBeenCalled();
    });

    it('rejects enrolling a GUARDIAN membership', async () => {
      classes.findOne.mockResolvedValue(classRow());
      memberships.findOne.mockResolvedValue({ id: 'm-guard', organizationId: ORG, personType: 'guardian' });
      await expect(
        service.enrol(ORG, 'c1', { studentMembershipId: 'm-guard' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a STUDENT membership into a class with room', async () => {
      classes.findOne.mockResolvedValue(classRow({ capacity: 2 }));
      memberships.findOne.mockResolvedValue({ id: 'm-stu', organizationId: ORG, personType: 'student' });
      tx.findOne
        .mockResolvedValueOnce(classRow({ capacity: 2 })) // lock
        .mockResolvedValueOnce(null); // no existing enrolment
      tx.count.mockResolvedValue(1); // 1 already enrolled, capacity 2 → room
      const e = await service.enrol(ORG, 'c1', { studentMembershipId: 'm-stu' }, 'admin');
      expect(e.status).toBe('enrolled');
      expect(e.studentMembershipId).toBe('m-stu');
    });

    it('rejects a duplicate enrolment (already enrolled)', async () => {
      classes.findOne.mockResolvedValue(classRow());
      memberships.findOne.mockResolvedValue({ id: 'm-stu', personType: 'student' });
      tx.findOne
        .mockResolvedValueOnce(classRow()) // lock
        .mockResolvedValueOnce({ id: 'e1', status: 'enrolled' }); // existing
      await expect(
        service.enrol(ORG, 'c1', { studentMembershipId: 'm-stu' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the class is at capacity', async () => {
      classes.findOne.mockResolvedValue(classRow({ capacity: 1 }));
      memberships.findOne.mockResolvedValue({ id: 'm-stu', personType: 'student' });
      tx.findOne
        .mockResolvedValueOnce(classRow({ capacity: 1 })) // lock
        .mockResolvedValueOnce(null); // no existing
      tx.count.mockResolvedValue(1); // 1 enrolled, capacity 1 → full
      await expect(
        service.enrol(ORG, 'c1', { studentMembershipId: 'm-stu' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('re-enrols a previously WITHDRAWN student on the same row', async () => {
      classes.findOne.mockResolvedValue(classRow());
      memberships.findOne.mockResolvedValue({ id: 'm-stu', personType: 'student' });
      const withdrawn = { id: 'e1', status: 'withdrawn', withdrawnAt: new Date(), completedAt: null };
      tx.findOne
        .mockResolvedValueOnce(classRow()) // lock
        .mockResolvedValueOnce(withdrawn); // existing withdrawn row
      const e = await service.enrol(ORG, 'c1', { studentMembershipId: 'm-stu' }, 'admin');
      expect(e.status).toBe('enrolled');
      expect(e.withdrawnAt).toBeNull();
      // Re-used the SAME row (never violates the (class, student) unique index).
      expect(tx.create).not.toHaveBeenCalled();
    });

    it('rejects enrolment into an inactive class', async () => {
      classes.findOne.mockResolvedValue(classRow({ isActive: false }));
      await expect(
        service.enrol(ORG, 'c1', { studentMembershipId: 'm-stu' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── withdraw / complete transitions ────────────────────────────────────────
  describe('withdraw / complete', () => {
    it('withdraw flips status to withdrawn and stamps withdrawnAt', async () => {
      enrolments.findOne.mockResolvedValue({ id: 'e1', classId: 'c1', organizationId: ORG, status: 'enrolled', enrolledAt: new Date(), withdrawnAt: null, completedAt: null });
      const e = await service.withdraw(ORG, 'c1', 'e1', 'admin');
      expect(e.status).toBe('withdrawn');
      expect(e.withdrawnAt).not.toBeNull();
    });

    it('complete refuses a withdrawn enrolment', async () => {
      enrolments.findOne.mockResolvedValue({ id: 'e1', classId: 'c1', organizationId: ORG, status: 'withdrawn' });
      await expect(service.complete(ORG, 'c1', 'e1', 'admin')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('withdraw on a missing enrolment 404s', async () => {
      enrolments.findOne.mockResolvedValue(null);
      await expect(service.withdraw(ORG, 'c1', 'nope', 'admin')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── roster access + student-only ───────────────────────────────────────────
  describe('roster', () => {
    it('an admin sees only actively-enrolled students', async () => {
      classes.findOne.mockResolvedValue(classRow());
      enrolments.find.mockResolvedValue([
        { id: 'e1', studentMembershipId: 'm-stu', status: 'enrolled', enrolledAt: new Date() },
      ]);
      memberships.find.mockResolvedValue([
        { id: 'm-stu', userId: 'u-stu', email: 's@x.test', personType: 'student' },
      ]);
      users.find.mockResolvedValue([{ id: 'u-stu', firstName: 'Sam', lastName: 'Student', email: 's@x.test' }]);
      const roster = await service.roster(ORG, 'c1', { userId: 'owner', orgRole: 'owner' });
      expect(roster).toHaveLength(1);
      expect(roster[0].studentMembershipId).toBe('m-stu');
      expect(roster[0].name).toBe('Sam Student');
      // Only enrolled rows were queried.
      expect(enrolments.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'enrolled' }) }),
      );
    });

    it('a non-admin, non-teacher caller is forbidden', async () => {
      classes.findOne.mockResolvedValue(classRow({ teacherMembershipId: 'teacher-mem' }));
      memberships.findOne.mockResolvedValue({ id: 'someone-else' }); // caller's membership != teacher
      await expect(
        service.roster(ORG, 'c1', { userId: 'rando', orgRole: 'employee' }),
      ).rejects.toBeInstanceOf(Error);
    });
  });
});
