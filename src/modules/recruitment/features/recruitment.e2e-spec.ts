import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness } from '../../organization/features/support/org-harness';
import { RECRUITMENT_ENTITIES } from '../entities';

const feature = loadFeature('./recruitment.feature', { loadRelativePath: true });
const API = '/api/v1/recruitment';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      for (const entity of RECRUITMENT_ENTITIES) {
        const repo: Repository<any> = h.app.get(getRepositoryToken(entity));
        await repo.delete({ organizationId: In(oids) }).catch(() => undefined);
      }
    }
    await h.cleanup();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const api = () => request(h.app.getHttpServer());

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  const createOpening = async (o: CreatedOrg, title: string, extra: Record<string, unknown> = {}) =>
    (await api().post(`${API}/openings`).set(auth(o.ownerToken)).send({ title, ...extra }).expect(201)).body.data;

  const createCandidate = async (o: CreatedOrg, body: Record<string, unknown>, expect = 201) =>
    api().post(`${API}/candidates`).set(auth(o.ownerToken)).send(body).expect(expect);

  const stagesOf = async (o: CreatedOrg) => (await api().get(`${API}/stages`).set(auth(o.ownerToken)).expect(200)).body.data as any[];

  const withCandidateInOpening = async (name: string, openingTitle: string, openingExtra: Record<string, unknown> = {}) => {
    const org = await newOrg();
    const opening = await createOpening(org, openingTitle, openingExtra);
    const cand = (await createCandidate(org, { fullName: name, openingId: opening.id })).body.data;
    const detail = (await api().get(`${API}/candidates/${cand.id}`).set(auth(org.ownerToken)).expect(200)).body.data;
    return { org, opening, cand, applicationId: detail.applications[0].id as string };
  };

  test('an owner adds a candidate to an opening and finds them by skill', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let opening: any;
    let cand: any;
    given(/^an organization with an opening "(.*)"$/, async (title: string) => {
      org = await newOrg();
      opening = await createOpening(org, title, { skills: ['Python', 'PySpark'] });
    });
    when(/^the owner adds candidate "(.*)" with skill "(.*)" to the opening$/, async (name: string, skill: string) => {
      cand = (await createCandidate(org, { fullName: name, skills: [skill], phone: '9560971604', openingId: opening.id })).body.data;
      expect(cand.phone).toBe('+919560971604');
    });
    then(/^searching candidates for "(.*)" returns "(.*)"$/, async (q: string, name: string) => {
      const res = await api().get(`${API}/candidates`).query({ q }).set(auth(org.ownerToken)).expect(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].fullName).toBe(name);
      expect(res.body.data.items[0].applications[0].openingTitle).toBe('Data Engineer');
    });
    and('the opening board shows the candidate in the default stage', async () => {
      const res = await api().get(`${API}/openings/${opening.id}/board`).set(auth(org.ownerToken)).expect(200);
      const def = res.body.data.stages.find((s: any) => s.isDefault);
      expect(res.body.data.cards).toHaveLength(1);
      expect(res.body.data.cards[0].stageId).toBe(def.id);
      expect(res.body.data.cards[0].candidate.fullName).toBe('Ajoy Dutta');
    });
  });

  test('the same email cannot be entered twice', ({ given, when, then }) => {
    let org: CreatedOrg;
    let existingId: string;
    let res: request.Response;
    given(/^an organization with a candidate "(.*)" using email "(.*)"$/, async (name: string, email: string) => {
      org = await newOrg();
      existingId = (await createCandidate(org, { fullName: name, email })).body.data.id;
    });
    when(/^the owner adds candidate "(.*)" using email "(.*)"$/, async (name: string, email: string) => {
      res = await createCandidate(org, { fullName: name, email }, 409);
    });
    then('the create is rejected as a duplicate pointing at the existing candidate', () => {
      expect(res.body.duplicateId ?? res.body.message?.duplicateId).toBe(existingId);
    });
  });

  test('a member without the recruitment permission is refused', ({ given, when, then }) => {
    let token: string;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      const org = await newOrg();
      token = (await h.createEmployeeMember(org)).token;
    });
    when('the employee lists candidates', async () => {
      res = await api().get(`${API}/candidates`).set(auth(token));
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('another organization cannot read a candidate', ({ given, when, then }) => {
    let candidateId: string;
    let res: request.Response;
    given(/^an organization with a candidate "(.*)" using email "(.*)"$/, async (name: string, email: string) => {
      const org = await newOrg();
      candidateId = (await createCandidate(org, { fullName: name, email })).body.data.id;
    });
    when('the owner of a different organization opens that candidate', async () => {
      const other = await newOrg();
      res = await api().get(`${API}/candidates/${candidateId}`).set(auth(other.ownerToken));
    });
    then('the candidate is not found', () => {
      expect(res.status).toBe(404);
    });
  });

  test('moving a candidate to Rejected requires a reason and is recorded', ({ given, when, then }) => {
    let ctx: Awaited<ReturnType<typeof withCandidateInOpening>>;
    let res: request.Response;
    given(/^an organization with candidate "(.*)" in opening "(.*)"$/, async (name: string, title: string) => {
      ctx = await withCandidateInOpening(name, title);
    });
    when(/^the owner moves the application to "(.*)" without a reason$/, async (stageName: string) => {
      const stage = (await stagesOf(ctx.org)).find((s) => s.name === stageName);
      res = await api().patch(`${API}/applications/${ctx.applicationId}/move`).set(auth(ctx.org.ownerToken)).send({ stageId: stage.id });
    });
    then('the move is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
    when(/^the owner moves the application to "(.*)" with reason "(.*)"$/, async (stageName: string, reason: string) => {
      const stage = (await stagesOf(ctx.org)).find((s) => s.name === stageName);
      res = await api().patch(`${API}/applications/${ctx.applicationId}/move`).set(auth(ctx.org.ownerToken))
        .send({ stageId: stage.id, rejectionReason: reason }).expect(200);
    });
    then(/^the application status is "(.*)" with (\d+) stage events$/, async (status: string, n: string) => {
      const detail = (await api().get(`${API}/candidates/${ctx.cand.id}`).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      expect(detail.applications[0].status).toBe(status);
      expect(detail.applications[0].rejectionReason).toBe('Skills mismatch');
      expect(detail.applications[0].events).toHaveLength(Number(n));
      expect(detail.activities.some((a: any) => a.type === 'stage_change' && /Rejected/.test(a.body))).toBe(true);
    });
  });

  test('a view-only recruiter cannot see salary figures', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let candidateId: string;
    let token: string;
    let res: request.Response;
    given(/^an organization with a candidate whose current CTC is (\d+)$/, async (ctc: string) => {
      org = await newOrg();
      const created = await createCandidate(org, { fullName: 'Sagar Yadav', currentCtc: Number(ctc) });
      candidateId = created.body.data.id;
      expect(created.body.data.currentCtc).toBe(Number(ctc));
    });
    and('a member whose role grants recruitment view only', async () => {
      const role = await api().post('/api/v1/org/roles').set(auth(org.ownerToken))
        .send({ name: 'rec_viewer', displayName: 'Recruitment viewer', permissions: [{ resource: 'recruitment', actions: ['view'] }] }).expect(201);
      const email = `rec-viewer-${Date.now()}@example.test`;
      const member = await api().post('/api/v1/org/members').set(auth(org.ownerToken))
        .send({ email, roleId: role.body.data.id, firstName: 'Rec', lastName: 'Viewer' }).expect(201);
      h.trackUser(member.body.data.userId);
      token = await h.mintToken(email);
    });
    when('that member opens the candidate', async () => {
      res = await api().get(`${API}/candidates/${candidateId}`).set(auth(token)).expect(200);
    });
    then('the CTC is hidden from them', async () => {
      expect(res.body.data.candidate.currentCtc).toBeNull();
      expect(res.body.data.candidate.ctcHidden).toBe(true);
      await api().patch(`${API}/candidates/${candidateId}`).set(auth(token)).send({ currentCtc: 1 }).expect(403);
    });
  });

  test('an interviewer sees only their interview and submits a scorecard', ({ given, and, when, then }) => {
    let ctx: Awaited<ReturnType<typeof withCandidateInOpening>>;
    let interviewer: { userId: string; token: string };
    let interview: any;
    given(/^an organization with candidate "(.*)" in opening "(.*)"$/, async (name: string, title: string) => {
      ctx = await withCandidateInOpening(name, title);
    });
    and(/^an interview "(.*)" assigned to an employee$/, async (round: string) => {
      interviewer = await h.createEmployeeMember(ctx.org);
      interview = (await api().post(`${API}/interviews`).set(auth(ctx.org.ownerToken)).send({
        applicationId: ctx.applicationId, roundName: round, type: 'technical', scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
        durationMin: 45, interviewerIds: [interviewer.userId],
      }).expect(201)).body.data;
      expect(interview.criteria.length).toBeGreaterThan(0);
    });
    when('the interviewer lists their interviews', async () => {
      interview.mine = (await api().get(`${API}/interviews`).query({ scope: 'mine' }).set(auth(interviewer.token)).expect(200)).body.data;
    });
    then(/^they see "(.*)"$/, (round: string) => {
      expect(interview.mine.map((i: any) => i.roundName)).toEqual([round]);
    });
    and('they can open the candidate with limited access', async () => {
      const res = await api().get(`${API}/candidates/${ctx.cand.id}`).set(auth(interviewer.token)).expect(200);
      expect(res.body.data.access).toBe('interviewer');
      expect(res.body.data.activities).toEqual([]);
      await api().get(`${API}/interviews`).query({ scope: 'all' }).set(auth(interviewer.token)).expect(403);
    });
    when(/^the interviewer submits a "(.*)" scorecard rating every criterion (\d)$/, async (rec: string, n: string) => {
      const ratings = Object.fromEntries(interview.criteria.map((c: string) => [c, Number(n)]));
      await api().post(`${API}/interviews/${interview.id}/feedback`).set(auth(interviewer.token))
        .send({ ratings, recommendation: rec, strengths: 'Solid LangChain depth' }).expect(201);
    });
    then(/^the interview is completed with an overall rating of (\d)$/, async (n: string) => {
      const res = await api().get(`${API}/interviews/${interview.id}`).set(auth(ctx.org.ownerToken)).expect(200);
      expect(res.body.data.status).toBe('completed');
      expect(res.body.data.feedback[0].overallRating).toBe(Number(n));
    });
    and('a different employee cannot open that interview', async () => {
      const other = await h.createEmployeeMember(ctx.org);
      await api().get(`${API}/interviews/${interview.id}`).set(auth(other.token)).expect(404);
      await api().post(`${API}/interviews/${interview.id}/feedback`).set(auth(other.token)).send({ ratings: {}, recommendation: 'no' }).expect(403);
    });
  });

  test('importing the legacy spreadsheet merges people across sheets', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    const rows = [
      { sheet: 'BI Developer', opening: 'BI Developer', rowNumber: 2, fullName: 'Akash Shaw', phone: '+91 9804753101', email: 'akash.pshaw524@gmail.com', qualification: "Bachelor's Degree", experience: '7 years', currentCompany: '—', noticePeriod: '—', currentLocation: 'Noida', remarks: 'Source: resume; Notice period not mentioned', resumeUrl: 'https://drive.google.com/file/d/abc/view' },
      { sheet: 'Data Engineer', opening: 'Data Engineer', rowNumber: 2, fullName: 'Ajoy Dutta', phone: '9560971604', email: 'ajoydutta134@gmail.com', qualification: '—', experience: '10+ years', currentCompany: 'Optum Global Solutions', noticePeriod: 'Immediate Joiner', currentLocation: 'Delhi', remarks: 'Source: Data Engineer Profiles; Notice period not mentioned' },
      { sheet: 'Data Engineer', opening: 'Data Engineer', rowNumber: 3, fullName: 'Akash Shaw', phone: '+91 9804753101', email: 'akash.pshaw524@gmail.com', qualification: 'B.Com', experience: '9 years', currentCompany: 'Charger Logistics Inc.July 2022 – Present', noticePeriod: '—', currentLocation: 'Noida', remarks: 'Source: Data Engineer Profiles; Duplicate candidate - multiple versions' },
      { sheet: 'Data Engineer', opening: 'Data Engineer', rowNumber: 4, fullName: '—', phone: '—', email: '—' },
    ];
    let res: request.Response;
    given('an organization', async () => {
      org = await newOrg();
    });
    when('the owner dry-runs an import of rows from two role sheets sharing one email', async () => {
      res = await api().post(`${API}/candidates/import`).set(auth(org.ownerToken)).send({ rows, dryRun: true, defaultSource: 'cutshort' }).expect(201);
    });
    then(/^the dry run reports (\d+) created, (\d+) merged and (\d+) openings to create$/, (c: string, m: string, o: string) => {
      const s = res.body.data.summary;
      expect(s.created).toBe(Number(c));
      expect(s.merged).toBe(Number(m));
      expect(s.skipped).toBe(1);
      expect(s.openingsCreated).toHaveLength(Number(o));
      expect(s.applications).toBe(3);
    });
    and('nothing was written', async () => {
      const list = await api().get(`${API}/candidates`).set(auth(org.ownerToken)).expect(200);
      expect(list.body.data.total).toBe(0);
    });
    when('the owner commits the same import', async () => {
      res = await api().post(`${API}/candidates/import`).set(auth(org.ownerToken)).send({ rows, defaultSource: 'cutshort' }).expect(201);
      expect(res.body.data.summary.errors).toBe(0);
    });
    then(/^the org has (\d+) candidates and "(.*)" has (\d+) applications$/, async (n: string, title: string, apps: string) => {
      const list = await api().get(`${API}/candidates`).set(auth(org.ownerToken)).expect(200);
      expect(list.body.data.total).toBe(Number(n));
      const openings = (await api().get(`${API}/openings`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(openings.find((o: any) => o.title === title).counts.total).toBe(Number(apps));
    });
    and(/^"(.*)" has (\d+) months experience and a cleaned company$/, async (name: string, months: string) => {
      const list = await api().get(`${API}/candidates`).query({ q: name }).set(auth(org.ownerToken)).expect(200);
      const c = list.body.data.items[0];
      expect(c.totalExpMonths).toBe(Number(months));
      expect(c.currentCompany).toBe('Charger Logistics Inc.');
      expect(c.source).toBe('cutshort');
      expect(c.phone).toBe('+919804753101');
      expect(c.externalResumeUrl).toContain('drive.google.com');
      expect(c.applications).toHaveLength(2);
      const ajoy = (await api().get(`${API}/candidates`).query({ q: 'Ajoy' }).set(auth(org.ownerToken)).expect(200)).body.data.items[0];
      expect(ajoy.noticeStatus).toBe('immediate');
      expect(ajoy.noticePeriodDays).toBe(0);
    });
  });

  test('a CV is uploaded with typed-in details and shown as stored', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let opening: any;
    let fileId: string;
    let candidateId: string;
    const cvText = 'Sagar Yadav\nSenior Power BI Developer\nsagaryadav1108@gmail.com | +91 7509869971\n5+ years of experience building Kusto dashboards.';
    given(/^an organization with an opening "(.*)"$/, async (title: string) => {
      org = await newOrg();
      opening = await createOpening(org, title);
    });
    when('the owner uploads a text CV', async () => {
      const up = await api().post('/api/v1/media/upload').set(auth(org.ownerToken))
        .attach('file', Buffer.from(cvText), { filename: 'Cutshort-SagarYadav-Power-BI-Developer.txt', contentType: 'text/plain' }).expect(201);
      fileId = up.body.data.id;
    });
    then('the CV-reading endpoint no longer exists', async () => {
      await api().post(`${API}/candidates/parse`).set(auth(org.ownerToken)).send({ fileId }).expect(404);
    });
    when('the owner saves the candidate from the CV into the opening', async () => {
      const res = await api().post(`${API}/candidates/from-cv`).set(auth(org.ownerToken))
        .send({ fileId, openingId: opening.id, data: { fullName: 'Sagar Yadav', phone: '7509869971' } }).expect(201);
      expect(res.body.data.created).toBe(true);
      candidateId = res.body.data.candidate.id;
    });
    then('the candidate has the CV as primary, with only the typed-in details', async () => {
      const detail = (await api().get(`${API}/candidates/${candidateId}`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(detail.documents).toHaveLength(1);
      expect(detail.documents[0].isPrimary).toBe(true);
      expect(detail.applications[0].openingTitle).toBe('BI Developer');
      expect(detail.candidate.source).toBe('cutshort');
      // Nothing is read out of the file: the email in the CV was not filled in.
      expect(detail.candidate.email).toBeNull();
      expect(detail.candidate.phone).toBe('+917509869971');
      expect(detail.candidate).not.toHaveProperty('aiSummary');
      await api().post(`${API}/candidates/from-cv`).set(auth(org.ownerToken))
        .send({ fileId, data: { fullName: 'Sagar Y', phone: '7509869971' } }).expect(409);
    });
    and('the CV can be opened in the portal exactly as uploaded', async () => {
      const detail = (await api().get(`${API}/candidates/${candidateId}`).set(auth(org.ownerToken)).expect(200)).body.data;
      const doc = detail.documents[0];
      const file = await api().get(`${API}/candidates/${candidateId}/documents/${doc.id}/file`).set(auth(org.ownerToken)).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(file.headers['content-type']).toMatch(/text\/plain/);
      expect(file.headers['content-disposition']).toMatch(/^inline/);
      expect((file.body as Buffer).toString()).toBe(cvText);
      const preview = (await api().get(`${API}/candidates/${candidateId}/documents/${doc.id}/preview`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(preview.kind).toBe('file');
    });
  });

  test('an accepted offer hires the candidate and fills the opening', ({ given, when, then }) => {
    let ctx: Awaited<ReturnType<typeof withCandidateInOpening>>;
    given(/^an organization with candidate "(.*)" in opening "(.*)"$/, async (name: string, title: string) => {
      ctx = await withCandidateInOpening(name, title, { positions: 1 });
    });
    when('the owner drafts, sends and accepts an offer', async () => {
      const offer = (await api().post(`${API}/offers`).set(auth(ctx.org.ownerToken))
        .send({ applicationId: ctx.applicationId, designation: 'GenAI Engineer', offeredCtc: 2400000, joiningDate: '2026-10-15' }).expect(201)).body.data;
      await api().post(`${API}/offers/${offer.id}/status`).set(auth(ctx.org.ownerToken)).send({ status: 'accepted' }).expect(400);
      await api().post(`${API}/offers/${offer.id}/status`).set(auth(ctx.org.ownerToken)).send({ status: 'sent' }).expect(201);
      await api().post(`${API}/offers/${offer.id}/status`).set(auth(ctx.org.ownerToken)).send({ status: 'accepted' }).expect(201);
    });
    then('the application is hired and the opening is filled', async () => {
      const detail = (await api().get(`${API}/candidates/${ctx.cand.id}`).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      expect(detail.applications[0].status).toBe('hired');
      expect(detail.applications[0].events.map((e: any) => e.toStageName)).toEqual(['Sourced', 'Offer', 'Hired']);
      const opening = (await api().get(`${API}/openings/${ctx.opening.id}`).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      expect(opening.status).toBe('filled');
      const analytics = (await api().get(`${API}/analytics`).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      expect(analytics.totals.hires).toBe(1);
      expect(analytics.funnel.find((f: any) => f.name === 'Offer').reached).toBe(1);
    });
  });

  test('merging duplicate profiles keeps one candidate', ({ given, when, then }) => {
    let org: CreatedOrg;
    let primaryId: string;
    let dupId: string;
    given('an organization with two profiles of the same person', async () => {
      org = await newOrg();
      const opening = await createOpening(org, 'SAP Consultant');
      primaryId = (await createCandidate(org, { fullName: 'Chirag Mahajan', email: 'chiragmahajan9019@gmail.com' })).body.data.id;
      dupId = (await createCandidate(org, { fullName: 'Chirag M', phone: '+91 7508078278', skills: ['SAP ABAP'], openingId: opening.id })).body.data.id;
    });
    when('the owner merges the duplicate into the primary', async () => {
      await api().post(`${API}/candidates/merge`).set(auth(org.ownerToken)).send({ primaryId, duplicateId: dupId }).expect(201);
    });
    then("only the primary remains with the duplicate's phone and applications", async () => {
      const list = (await api().get(`${API}/candidates`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(list.total).toBe(1);
      const c = list.items[0];
      expect(c.id).toBe(primaryId);
      expect(c.phone).toBe('+917508078278');
      expect(c.skills).toEqual(['SAP ABAP']);
      expect(c.applications).toHaveLength(1);
      await api().get(`${API}/candidates/${dupId}`).set(auth(org.ownerToken)).expect(404);
    });
  });
});
