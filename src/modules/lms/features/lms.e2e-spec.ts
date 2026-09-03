import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { CourseEntity } from '../entities/course.entity';
import { ClassSectionEntity } from '../entities/class-section.entity';
import { EnrolmentEntity } from '../entities/enrolment.entity';
import { AcademicYearEntity } from '../../academic/entities/academic-year.entity';
import { TermEntity } from '../../academic/entities/term.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';

const feature = loadFeature('./lms.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let courses: Repository<CourseEntity>;
  let classes: Repository<ClassSectionEntity>;
  let enrolments: Repository<EnrolmentEntity>;
  let years: Repository<AcademicYearEntity>;
  let terms: Repository<TermEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    courses = h.app.get(getRepositoryToken(CourseEntity));
    classes = h.app.get(getRepositoryToken(ClassSectionEntity));
    enrolments = h.app.get(getRepositoryToken(EnrolmentEntity));
    years = h.app.get(getRepositoryToken(AcademicYearEntity));
    terms = h.app.get(getRepositoryToken(TermEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await enrolments.delete({ organizationId: In(ids) }).catch(() => undefined);
      await classes.delete({ organizationId: In(ids) }).catch(() => undefined);
      await courses.delete({ organizationId: In(ids) }).catch(() => undefined);
      await terms.delete({ organizationId: In(ids) }).catch(() => undefined);
      await years.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const org = async () => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  /** Create an academic year + one term, return the termId. */
  const makeTerm = async (o: CreatedOrg): Promise<string> => {
    const y = await h
      .api()
      .post(`${API}/academic/years`)
      .set(auth(o.ownerToken))
      .send({ name: `Y-${newObjectId()}`, startDate: '2025-06-01', endDate: '2026-05-31' })
      .expect(201);
    const t = await h
      .api()
      .post(`${API}/academic/years/${y.body.data.id}/terms`)
      .set(auth(o.ownerToken))
      .send({ name: 'Term 1', startDate: '2025-06-01', endDate: '2025-09-30' })
      .expect(201);
    return t.body.data.id;
  };

  const makeCourse = (o: CreatedOrg, code = `C-${newObjectId().slice(-6)}`) =>
    h.api().post(`${API}/lms/courses`).set(auth(o.ownerToken)).send({ code, name: 'Intro' });

  const makeClass = (o: CreatedOrg, courseId: string, termId: string, over: any = {}) =>
    h
      .api()
      .post(`${API}/lms/classes`)
      .set(auth(o.ownerToken))
      .send({ courseId, termId, section: 'A', ...over });

  /** Insert a raw STUDENT membership (as the future education vertical would). */
  const makeStudent = async (o: CreatedOrg): Promise<string> => {
    const userId = newObjectId();
    h.trackUser(userId);
    const row = await memberships.save(
      memberships.create({
        organizationId: o.orgId,
        userId,
        email: `student+${userId}@nugenova.test`,
        role: 'employee',
        status: 'active',
        personType: 'student',
      }),
    );
    return row.id;
  };

  const enrol = (o: CreatedOrg, classId: string, studentMembershipId: string) =>
    h
      .api()
      .post(`${API}/lms/classes/${classId}/enrolments`)
      .set(auth(o.ownerToken))
      .send({ studentMembershipId });

  test('an owner creates a course and a class/section', ({ given, when, then }) => {
    let o: CreatedOrg;
    let termId: string;
    let courseRes: request.Response;
    let classRes: request.Response;
    given('an organization with an academic year and term', async () => {
      o = await org();
      termId = await makeTerm(o);
    });
    when('the owner creates a course and a class in that term', async () => {
      courseRes = await makeCourse(o).expect(201);
      classRes = await makeClass(o, courseRes.body.data.id, termId).expect(201);
    });
    then('the course and class are created', () => {
      expect(courseRes.body.data.isActive).toBe(true);
      expect(classRes.body.data.section).toBe('A');
      expect(classRes.body.data.enrolledCount).toBe(0);
    });
  });

  test('an employee cannot author courses', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { token: string };
    let res: request.Response;
    given('an organization with an employee', async () => {
      o = await org();
      emp = await h.createEmployeeMember(o);
    });
    when('the employee tries to create a course', async () => {
      res = await h
        .api()
        .post(`${API}/lms/courses`)
        .set(auth(emp.token))
        .send({ code: 'X-1', name: 'Nope' });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("one org cannot see another org's courses", ({ given, when, then }) => {
    let a: CreatedOrg;
    let b: CreatedOrg;
    let res: request.Response;
    given('two organizations that each have a course', async () => {
      a = await org();
      b = await org();
      await makeCourse(a, 'A-CODE').expect(201);
      await makeCourse(b, 'B-CODE').expect(201);
    });
    when("the first organization's owner lists courses", async () => {
      res = await h.api().get(`${API}/lms/courses`).set(auth(a.ownerToken)).expect(200);
    });
    then("only the first organization's courses are returned", () => {
      const codes = (res.body.data as any[]).map((c) => c.code);
      expect(codes).toContain('A-CODE');
      expect(codes).not.toContain('B-CODE');
    });
  });

  test('a class teacher must be a staff member', ({ given, when, then }) => {
    let o: CreatedOrg;
    let courseId: string;
    let termId: string;
    let studentMembershipId: string;
    let res: request.Response;
    given('an organization with a course, a term and a student membership', async () => {
      o = await org();
      termId = await makeTerm(o);
      courseId = (await makeCourse(o).expect(201)).body.data.id;
      studentMembershipId = await makeStudent(o);
    });
    when('the owner tries to assign the student as the class teacher', async () => {
      res = await makeClass(o, courseId, termId, { teacherMembershipId: studentMembershipId });
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('only a student membership can be enrolled', ({ given, when, then }) => {
    let o: CreatedOrg;
    let classId: string;
    let staffMembershipId: string;
    let res: request.Response;
    given('an organization with a class and a staff member', async () => {
      o = await org();
      const termId = await makeTerm(o);
      const courseId = (await makeCourse(o).expect(201)).body.data.id;
      classId = (await makeClass(o, courseId, termId).expect(201)).body.data.id;
      const emp = await h.createEmployeeMember(o);
      const m = await memberships.findOne({
        where: { userId: emp.userId, organizationId: o.orgId },
      });
      staffMembershipId = m!.id;
    });
    when('the owner tries to enrol the staff member', async () => {
      res = await enrol(o, classId, staffMembershipId);
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a student is enrolled and cannot be enrolled twice', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let classId: string;
    let studentMembershipId: string;
    let enrolRes: request.Response;
    given('an organization with a class and a student membership', async () => {
      o = await org();
      const termId = await makeTerm(o);
      const courseId = (await makeCourse(o).expect(201)).body.data.id;
      classId = (await makeClass(o, courseId, termId).expect(201)).body.data.id;
      studentMembershipId = await makeStudent(o);
    });
    when('the owner enrols the student', async () => {
      enrolRes = await enrol(o, classId, studentMembershipId).expect(201);
    });
    then('the student is enrolled', () => {
      expect(enrolRes.body.data.status).toBe('enrolled');
      expect(enrolRes.body.data.studentMembershipId).toBe(studentMembershipId);
    });
    and('enrolling the same student again is rejected', async () => {
      const dup = await enrol(o, classId, studentMembershipId);
      expect(dup.status).toBe(400);
    });
  });

  test('capacity is enforced', ({ given, when, then }) => {
    let o: CreatedOrg;
    let classId: string;
    let s1: string;
    let s2: string;
    given('an organization with a class of capacity one and two students', async () => {
      o = await org();
      const termId = await makeTerm(o);
      const courseId = (await makeCourse(o).expect(201)).body.data.id;
      classId = (await makeClass(o, courseId, termId, { capacity: 1 }).expect(201)).body.data.id;
      s1 = await makeStudent(o);
      s2 = await makeStudent(o);
    });
    when('the owner enrols the first student', async () => {
      await enrol(o, classId, s1).expect(201);
    });
    then('enrolling the second student is rejected as full', async () => {
      const res = await enrol(o, classId, s2);
      expect(res.status).toBe(400);
    });
  });

  test('withdrawing is a soft status transition', ({ given, when, then }) => {
    let o: CreatedOrg;
    let classId: string;
    let enrolmentId: string;
    let studentMembershipId: string;
    given('an organization with a class and an enrolled student', async () => {
      o = await org();
      const termId = await makeTerm(o);
      const courseId = (await makeCourse(o).expect(201)).body.data.id;
      classId = (await makeClass(o, courseId, termId).expect(201)).body.data.id;
      studentMembershipId = await makeStudent(o);
      enrolmentId = (await enrol(o, classId, studentMembershipId).expect(201)).body.data.id;
    });
    when('the owner withdraws the student', async () => {
      await h
        .api()
        .put(`${API}/lms/classes/${classId}/enrolments/${enrolmentId}/withdraw`)
        .set(auth(o.ownerToken))
        .expect(200);
    });
    then('the enrolment status becomes withdrawn and the row still exists', async () => {
      const row = await enrolments.findOne({ where: { id: enrolmentId } });
      expect(row).toBeTruthy();
      expect(row!.status).toBe('withdrawn');
      expect(row!.withdrawnAt).toBeTruthy();
    });
  });

  test('the class roster lists only enrolled students', ({ given, when, then }) => {
    let o: CreatedOrg;
    let classId: string;
    let enrolledStudent: string;
    let withdrawnStudent: string;
    let roster: request.Response;
    given('an organization with a class, an enrolled student and a withdrawn student', async () => {
      o = await org();
      const termId = await makeTerm(o);
      const courseId = (await makeCourse(o).expect(201)).body.data.id;
      classId = (await makeClass(o, courseId, termId).expect(201)).body.data.id;
      enrolledStudent = await makeStudent(o);
      withdrawnStudent = await makeStudent(o);
      await enrol(o, classId, enrolledStudent).expect(201);
      const w = await enrol(o, classId, withdrawnStudent).expect(201);
      await h
        .api()
        .put(`${API}/lms/classes/${classId}/enrolments/${w.body.data.id}/withdraw`)
        .set(auth(o.ownerToken))
        .expect(200);
    });
    when('the owner reads the class roster', async () => {
      roster = await h
        .api()
        .get(`${API}/lms/classes/${classId}/roster`)
        .set(auth(o.ownerToken))
        .expect(200);
    });
    then('only the enrolled student appears on the roster', () => {
      const ids = (roster.body.data as any[]).map((r) => r.studentMembershipId);
      expect(ids).toContain(enrolledStudent);
      expect(ids).not.toContain(withdrawnStudent);
      expect(ids).toHaveLength(1);
    });
  });
});
