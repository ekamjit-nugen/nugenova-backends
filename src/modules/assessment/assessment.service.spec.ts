import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { AssessmentService } from './assessment.service';
import { AssessmentEntity } from './entities/assessment.entity';
import { MarkEntity } from './entities/mark.entity';
import { ClassSectionEntity } from '../lms/entities/class-section.entity';
import { EnrolmentEntity } from '../lms/entities/enrolment.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

/**
 * Pure unit specs — NO database. These pin the gradebook invariants and act as a
 * BUILD-FAILING regression guard: the build goes red if the service ever stops
 * rejecting an out-of-range mark, grades a non-enrolled or non-student subject,
 * duplicates a mark row on re-grade, or miscomputes the weighted total.
 *
 * The fakes carry a real in-memory `personType`/`status`, so a test only passes
 * if the service actually inspects them.
 */
describe('AssessmentService (unit, no DB)', () => {
  let service: AssessmentService;
  let assessments: any;
  let marks: any;
  let classes: any;
  let enrolments: any;
  let memberships: any;
  let users: any;

  const ORG = 'org1';
  const CLASS = 'class1';

  const classRow = (over: Partial<ClassSectionEntity> = {}): any => ({
    id: CLASS,
    organizationId: ORG,
    courseId: 'course1',
    termId: 'term1',
    section: 'A',
    teacherMembershipId: null,
    capacity: null,
    isActive: true,
    ...over,
  });

  const assessmentRow = (over: Partial<AssessmentEntity> = {}): any => ({
    id: 'a1',
    organizationId: ORG,
    classSectionId: CLASS,
    termId: 'term1',
    title: 'Quiz 1',
    type: 'quiz',
    maxMarks: 20,
    weight: 1,
    dueDate: null,
    published: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  const enrolledRow = (over: Partial<EnrolmentEntity> = {}): any => ({
    id: 'e1',
    organizationId: ORG,
    classId: CLASS,
    studentMembershipId: 'm-stu',
    status: 'enrolled',
    enrolledAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    assessments = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 'a1', createdAt: new Date(), updatedAt: new Date(), ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({}),
    };
    marks = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 'mk1', ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({}),
    };
    classes = { findOne: jest.fn().mockResolvedValue(classRow()) };
    enrolments = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(enrolledRow()),
    };
    memberships = {
      findOne: jest.fn().mockResolvedValue({ id: 'm-stu', organizationId: ORG, personType: 'student' }),
      find: jest.fn().mockResolvedValue([]),
    };
    users = { find: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssessmentService,
        { provide: getRepositoryToken(AssessmentEntity), useValue: assessments },
        { provide: getRepositoryToken(MarkEntity), useValue: marks },
        { provide: getRepositoryToken(ClassSectionEntity), useValue: classes },
        { provide: getRepositoryToken(EnrolmentEntity), useValue: enrolments },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: memberships },
        { provide: getRepositoryToken(UserEntity), useValue: users },
      ],
    }).compile();
    service = moduleRef.get(AssessmentService);
  });

  // ── createAssessment: term derived from the class ─────────────────────────────
  describe('createAssessment', () => {
    it("derives the assessment's termId from the class (never the client)", async () => {
      classes.findOne.mockResolvedValue(classRow({ id: CLASS, termId: 'term-XYZ' }));
      const a = await service.createAssessment(
        ORG,
        CLASS,
        { title: 'Midterm', type: 'exam', maxMarks: 100 },
        'admin',
      );
      expect(a.termId).toBe('term-XYZ');
      expect(a.classSectionId).toBe(CLASS);
      expect(a.weight).toBe(1); // default
    });

    it('404s when the class does not exist in the org', async () => {
      classes.findOne.mockResolvedValue(null);
      await expect(
        service.createAssessment(ORG, 'nope', { title: 'X', type: 'quiz', maxMarks: 10 }, 'admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── recordMark: the BUILD-FAILING guards ──────────────────────────────────────
  describe('recordMark', () => {
    it('rejects a mark outside [0, maxMarks]', async () => {
      assessments.findOne.mockResolvedValue(assessmentRow({ maxMarks: 20 }));
      enrolments.findOne.mockResolvedValue(enrolledRow());
      await expect(
        service.recordMark(ORG, 'a1', { enrolmentId: 'e1', marksObtained: 21 }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Never wrote a mark row.
      expect(marks.save).not.toHaveBeenCalled();
    });

    it('rejects a negative mark', async () => {
      assessments.findOne.mockResolvedValue(assessmentRow({ maxMarks: 20 }));
      enrolments.findOne.mockResolvedValue(enrolledRow());
      await expect(
        service.recordMark(ORG, 'a1', { enrolmentId: 'e1', marksObtained: -1 }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects grading a non-enrolled (withdrawn) student', async () => {
      assessments.findOne.mockResolvedValue(assessmentRow());
      enrolments.findOne.mockResolvedValue(enrolledRow({ status: 'withdrawn' }));
      await expect(
        service.recordMark(ORG, 'a1', { enrolmentId: 'e1', marksObtained: 10 }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects grading a subject whose membership is not a STUDENT', async () => {
      assessments.findOne.mockResolvedValue(assessmentRow());
      enrolments.findOne.mockResolvedValue(enrolledRow());
      memberships.findOne.mockResolvedValue({ id: 'm-stu', organizationId: ORG, personType: 'staff' });
      await expect(
        service.recordMark(ORG, 'a1', { enrolmentId: 'e1', marksObtained: 10 }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a fresh mark and denormalizes the studentMembershipId', async () => {
      assessments.findOne.mockResolvedValue(assessmentRow({ maxMarks: 20 }));
      enrolments.findOne.mockResolvedValue(enrolledRow({ id: 'e1', studentMembershipId: 'm-stu' }));
      marks.findOne.mockResolvedValue(null); // no existing mark
      const mk = await service.recordMark(ORG, 'a1', { enrolmentId: 'e1', marksObtained: 18, remark: 'good' }, 'admin');
      expect(mk.marksObtained).toBe(18);
      expect(mk.studentMembershipId).toBe('m-stu');
      expect(mk.gradedAt).not.toBeNull();
      expect(marks.create).toHaveBeenCalled();
    });

    it('re-grade UPDATES THE SAME row (never inserts a duplicate)', async () => {
      assessments.findOne.mockResolvedValue(assessmentRow({ maxMarks: 20 }));
      enrolments.findOne.mockResolvedValue(enrolledRow());
      const existing = { id: 'mk1', assessmentId: 'a1', enrolmentId: 'e1', studentMembershipId: 'm-stu', marksObtained: 10, remark: null };
      marks.findOne.mockResolvedValue(existing);
      const mk = await service.recordMark(ORG, 'a1', { enrolmentId: 'e1', marksObtained: 15 }, 'grader2');
      expect(mk.id).toBe('mk1'); // same row id
      expect(mk.marksObtained).toBe(15);
      expect(marks.create).not.toHaveBeenCalled(); // no new row
    });

    it('marksObtained omitted clears the grade back to null (not graded)', async () => {
      assessments.findOne.mockResolvedValue(assessmentRow());
      enrolments.findOne.mockResolvedValue(enrolledRow());
      marks.findOne.mockResolvedValue({ id: 'mk1', assessmentId: 'a1', enrolmentId: 'e1', studentMembershipId: 'm-stu', marksObtained: 10 });
      const mk = await service.recordMark(ORG, 'a1', { enrolmentId: 'e1' }, 'admin');
      expect(mk.marksObtained).toBeNull();
      expect(mk.gradedAt).toBeNull();
    });
  });

  // ── weighted total computation ────────────────────────────────────────────────
  describe('gradebook — weighted total', () => {
    it('weights each graded assessment by weight × (obtained / maxMarks), ignoring ungraded', async () => {
      // Two assessments: quiz (max 10, weight 1), exam (max 100, weight 3), and an
      // ungraded project (weight 6) that must NOT drag the weighted % down.
      const quiz = assessmentRow({ id: 'a-quiz', maxMarks: 10, weight: 1 });
      const exam = assessmentRow({ id: 'a-exam', maxMarks: 100, weight: 3 });
      const proj = assessmentRow({ id: 'a-proj', maxMarks: 50, weight: 6 });
      assessments.find.mockResolvedValue([quiz, exam, proj]);
      enrolments.find.mockResolvedValue([enrolledRow({ id: 'e1', studentMembershipId: 'm-stu' })]);
      memberships.find.mockResolvedValue([{ id: 'm-stu', userId: 'u1', email: 's@x.test', personType: 'student' }]);
      users.find.mockResolvedValue([{ id: 'u1', firstName: 'Sam', lastName: 'Student', email: 's@x.test' }]);
      // quiz 8/10 = 0.8, exam 90/100 = 0.9 ; project ungraded.
      marks.find.mockResolvedValue([
        { id: 'mk1', enrolmentId: 'e1', assessmentId: 'a-quiz', marksObtained: 8, remark: null },
        { id: 'mk2', enrolmentId: 'e1', assessmentId: 'a-exam', marksObtained: 90, remark: null },
      ]);

      const gb = await service.gradebook(ORG, CLASS, { userId: 'owner', orgRole: 'owner' });
      expect(gb.rows).toHaveLength(1);
      const row = gb.rows[0];
      // numer = 1*0.8 + 3*0.9 = 3.5 ; denom = 1 + 3 = 4 ; % = 87.5
      expect(row.weightedPercentage).toBe(87.5);
      expect(row.gradedCount).toBe(2);
      expect(row.totalObtained).toBe(98); // 8 + 90
      expect(row.totalMax).toBe(110); // 10 + 100 (ungraded project excluded)
      expect(row.name).toBe('Sam Student');
      // Matrix has a cell per assessment (including the ungraded project = null).
      expect(row.cells).toHaveLength(3);
      const proje = row.cells.find((c) => c.assessmentId === 'a-proj');
      expect(proje?.marksObtained).toBeNull();
      expect(proje?.percentage).toBeNull();
    });

    it('weighted % is 0 when the student has no graded assessments', async () => {
      assessments.find.mockResolvedValue([assessmentRow({ id: 'a1', maxMarks: 10, weight: 1 })]);
      enrolments.find.mockResolvedValue([enrolledRow({ id: 'e1', studentMembershipId: 'm-stu' })]);
      memberships.find.mockResolvedValue([{ id: 'm-stu', userId: null, email: 's@x.test', personType: 'student' }]);
      marks.find.mockResolvedValue([]);
      const gb = await service.gradebook(ORG, CLASS, { userId: 'owner', orgRole: 'owner' });
      expect(gb.rows[0].weightedPercentage).toBe(0);
      expect(gb.rows[0].gradedCount).toBe(0);
    });

    it('a non-admin, non-teacher caller is forbidden', async () => {
      classes.findOne.mockResolvedValue(classRow({ teacherMembershipId: 'teacher-mem' }));
      memberships.findOne.mockResolvedValue({ id: 'someone-else' });
      await expect(
        service.gradebook(ORG, CLASS, { userId: 'rando', orgRole: 'employee' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── student report ────────────────────────────────────────────────────────────
  describe('studentReport', () => {
    it('reports one enrolment\'s marks and overall weighted total', async () => {
      enrolments.findOne.mockResolvedValue(enrolledRow({ id: 'e1', classId: CLASS, studentMembershipId: 'm-stu' }));
      classes.findOne.mockResolvedValue(classRow());
      assessments.find.mockResolvedValue([
        assessmentRow({ id: 'a-quiz', maxMarks: 10, weight: 1 }),
        assessmentRow({ id: 'a-exam', maxMarks: 100, weight: 1 }),
      ]);
      memberships.find.mockResolvedValue([{ id: 'm-stu', userId: 'u1', email: 's@x.test', personType: 'student' }]);
      users.find.mockResolvedValue([{ id: 'u1', firstName: 'Sam', lastName: 'Student', email: 's@x.test' }]);
      marks.find.mockResolvedValue([
        { id: 'mk1', enrolmentId: 'e1', assessmentId: 'a-quiz', marksObtained: 5, remark: null }, // 50%
        { id: 'mk2', enrolmentId: 'e1', assessmentId: 'a-exam', marksObtained: 100, remark: null }, // 100%
      ]);
      const rep = await service.studentReport(ORG, 'e1', { userId: 'owner', orgRole: 'owner' });
      expect(rep.entries).toHaveLength(2);
      // equal weights: (0.5 + 1.0) / 2 = 0.75 → 75%
      expect(rep.weightedPercentage).toBe(75);
      expect(rep.studentMembershipId).toBe('m-stu');
      expect(rep.name).toBe('Sam Student');
    });
  });
});
