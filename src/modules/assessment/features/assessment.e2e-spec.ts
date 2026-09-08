import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { AssessmentEntity } from '../entities/assessment.entity';
import { MarkEntity } from '../entities/mark.entity';
import { CourseEntity } from '../../lms/entities/course.entity';
import { ClassSectionEntity } from '../../lms/entities/class-section.entity';
import { EnrolmentEntity } from '../../lms/entities/enrolment.entity';
import { AcademicYearEntity } from '../../academic/entities/academic-year.entity';
import { TermEntity } from '../../academic/entities/term.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';

const feature = loadFeature('./assessment.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let assessments: Repository<AssessmentEntity>;
  let marks: Repository<MarkEntity>;
  let courses: Repository<CourseEntity>;
  let classes: Repository<ClassSectionEntity>;
  let enrolments: Repository<EnrolmentEntity>;
  let years: Repository<AcademicYearEntity>;
  let terms: Repository<TermEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    assessments = h.app.get(getRepositoryToken(AssessmentEntity));
    marks = h.app.get(getRepositoryToken(MarkEntity));
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
      await marks.delete({ organizationId: In(ids) }).catch(() => undefined);
      await assessments.delete({ organizationId: In(ids) }).catch(() => undefined);
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

  /** A class with its own fresh course + term; returns { classId, termId }. */
  const makeClass = async (o: CreatedOrg): Promise<{ classId: string; termId: string }> => {
    const termId = await makeTerm(o);
    const courseId = (await makeCourse(o).expect(201)).body.data.id;
    const cls = await h
      .api()
      .post(`${API}/lms/classes`)
      .set(auth(o.ownerToken))
      .send({ courseId, termId, section: 'A' })
      .expect(201);
    return { classId: cls.body.data.id, termId };
  };

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

  /** Enrol a student into a class; returns the enrolmentId. */
  const enrol = async (o: CreatedOrg, classId: string, studentMembershipId: string): Promise<string> => {
    const res = await h
      .api()
      .post(`${API}/lms/classes/${classId}/enrolments`)
      .set(auth(o.ownerToken))
      .send({ studentMembershipId })
      .expect(201);
    return res.body.data.id;
  };

  const makeAssessment = (o: CreatedOrg, classId: string, body: any = {}) =>
    h
      .api()
      .post(`${API}/assessment/classes/${classId}/assessments`)
      .set(auth(o.ownerToken))
      .send({ title: 'Quiz 1', type: 'quiz', maxMarks: 20, weight: 1, ...body });

  const recordMark = (o: CreatedOrg, assessmentId: string, body: any) =>
    h
      .api()
      .post(`${API}/assessment/assessments/${assessmentId}/marks`)
      .set(auth(o.ownerToken))
      .send(body);

  test('an owner creates an assessment on a class', ({ given, when, then }) => {
    let o: CreatedOrg;
    let classId: string;
    let termId: string;
    let res: request.Response;
    given('an organization with a class in a term', async () => {
      o = await org();
      ({ classId, termId } = await makeClass(o));
    });
    when('the owner creates an assessment for that class', async () => {
      res = await makeAssessment(o, classId, { title: 'Midterm', type: 'exam', maxMarks: 100 }).expect(201);
    });
    then("the assessment is created with the class's term", () => {
      expect(res.body.data.title).toBe('Midterm');
      expect(res.body.data.classSectionId).toBe(classId);
      expect(res.body.data.termId).toBe(termId);
      expect(res.body.data.maxMarks).toBe(100);
      expect(res.body.data.published).toBe(false);
    });
  });

  test('an employee cannot author assessments', ({ given, when, then }) => {
    let o: CreatedOrg;
    let classId: string;
    let emp: { token: string };
    let res: request.Response;
    given('an organization with a class and an employee', async () => {
      o = await org();
      ({ classId } = await makeClass(o));
      emp = await h.createEmployeeMember(o);
    });
    when('the employee tries to create an assessment', async () => {
      res = await h
        .api()
        .post(`${API}/assessment/classes/${classId}/assessments`)
        .set(auth(emp.token))
        .send({ title: 'Nope', type: 'quiz', maxMarks: 10 });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("one org cannot grade into another org's class", ({ given, when, then }) => {
    let a: CreatedOrg;
    let b: CreatedOrg;
    let bClassId: string;
    let res: request.Response;
    given('two organizations that each have a class', async () => {
      a = await org();
      b = await org();
      ({ classId: bClassId } = await makeClass(b));
    });
    when("the first organization's owner reads the second organization's gradebook", async () => {
      res = await h
        .api()
        .get(`${API}/assessment/classes/${bClassId}/gradebook`)
        .set(auth(a.ownerToken));
    });
    then('the request is rejected as not found', () => {
      expect(res.status).toBe(404);
    });
  });

  test('only an enrolled student can be graded', ({ given, when, then }) => {
    let o: CreatedOrg;
    let assessmentId: string;
    let enrolmentId: string;
    let res: request.Response;
    given('an organization with an assessment and a withdrawn student', async () => {
      o = await org();
      const { classId } = await makeClass(o);
      assessmentId = (await makeAssessment(o, classId).expect(201)).body.data.id;
      const student = await makeStudent(o);
      enrolmentId = await enrol(o, classId, student);
      await h
        .api()
        .put(`${API}/lms/classes/${classId}/enrolments/${enrolmentId}/withdraw`)
        .set(auth(o.ownerToken))
        .expect(200);
    });
    when('the owner tries to record a mark for the withdrawn student', async () => {
      res = await recordMark(o, assessmentId, { enrolmentId, marksObtained: 10 });
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a mark must be within range', ({ given, when, then }) => {
    let o: CreatedOrg;
    let assessmentId: string;
    let enrolmentId: string;
    let res: request.Response;
    given('an organization with an assessment out of twenty and an enrolled student', async () => {
      o = await org();
      const { classId } = await makeClass(o);
      assessmentId = (await makeAssessment(o, classId, { maxMarks: 20 }).expect(201)).body.data.id;
      const student = await makeStudent(o);
      enrolmentId = await enrol(o, classId, student);
    });
    when('the owner records a mark above the maximum', async () => {
      res = await recordMark(o, assessmentId, { enrolmentId, marksObtained: 21 });
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('recording and re-grading updates the same mark row', ({ given, when, then }) => {
    let o: CreatedOrg;
    let assessmentId: string;
    let enrolmentId: string;
    given('an organization with an assessment and an enrolled student', async () => {
      o = await org();
      const { classId } = await makeClass(o);
      assessmentId = (await makeAssessment(o, classId, { maxMarks: 20 }).expect(201)).body.data.id;
      const student = await makeStudent(o);
      enrolmentId = await enrol(o, classId, student);
    });
    when('the owner records a mark and then re-grades it', async () => {
      await recordMark(o, assessmentId, { enrolmentId, marksObtained: 10 }).expect(201);
      await recordMark(o, assessmentId, { enrolmentId, marksObtained: 18 }).expect(201);
    });
    then('the latest mark is stored on a single row', async () => {
      const rows = await marks.find({ where: { assessmentId, enrolmentId } });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].marksObtained)).toBe(18);
    });
  });

  test('the class gradebook rolls up a weighted total', ({ given, when, then }) => {
    let o: CreatedOrg;
    let classId: string;
    let enrolmentId: string;
    let gb: request.Response;
    given('an organization with two weighted assessments and an enrolled student', async () => {
      o = await org();
      ({ classId } = await makeClass(o));
      const student = await makeStudent(o);
      enrolmentId = await enrol(o, classId, student);
      // quiz: max 10, weight 1 ; exam: max 100, weight 3
      const quiz = (await makeAssessment(o, classId, { title: 'Quiz', maxMarks: 10, weight: 1 }).expect(201)).body.data.id;
      const exam = (await makeAssessment(o, classId, { title: 'Exam', type: 'exam', maxMarks: 100, weight: 3 }).expect(201)).body.data.id;
      await recordMark(o, quiz, { enrolmentId, marksObtained: 8 }).expect(201); // 80%
      await recordMark(o, exam, { enrolmentId, marksObtained: 90 }).expect(201); // 90%
    });
    when('the owner records marks and reads the gradebook', async () => {
      gb = await h
        .api()
        .get(`${API}/assessment/classes/${classId}/gradebook`)
        .set(auth(o.ownerToken))
        .expect(200);
    });
    then("the student's weighted percentage is computed", () => {
      expect(gb.body.data.assessments).toHaveLength(2);
      expect(gb.body.data.rows).toHaveLength(1);
      const row = gb.body.data.rows[0];
      // numer = 1*0.8 + 3*0.9 = 3.5 ; denom = 4 ; % = 87.5
      expect(row.weightedPercentage).toBe(87.5);
      expect(row.enrolmentId).toBe(enrolmentId);
      expect(row.cells).toHaveLength(2);
    });
  });

  test("a student report shows the student's marks and overall", ({ given, when, then }) => {
    let o: CreatedOrg;
    let enrolmentId: string;
    let report: request.Response;
    given('an organization with an assessment and a graded student', async () => {
      o = await org();
      const { classId } = await makeClass(o);
      const student = await makeStudent(o);
      enrolmentId = await enrol(o, classId, student);
      const a = (await makeAssessment(o, classId, { maxMarks: 20, weight: 1 }).expect(201)).body.data.id;
      await recordMark(o, a, { enrolmentId, marksObtained: 15, remark: 'solid' }).expect(201); // 75%
    });
    when("the owner reads the student's report", async () => {
      report = await h
        .api()
        .get(`${API}/assessment/enrolments/${enrolmentId}/report`)
        .set(auth(o.ownerToken))
        .expect(200);
    });
    then('the report lists the marks and the overall weighted percentage', () => {
      expect(report.body.data.entries).toHaveLength(1);
      expect(report.body.data.entries[0].marksObtained).toBe(15);
      expect(report.body.data.entries[0].percentage).toBe(75);
      expect(report.body.data.weightedPercentage).toBe(75);
    });
  });
});
