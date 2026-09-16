import * as fs from 'fs';
import * as path from 'path';
import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness } from '../../organization/features/support/org-harness';
import { RECRUITMENT_ENTITIES } from '../entities';
import { LeadEntity } from '../../sales/entities/lead.entity';
import { RequirementEntity } from '../../sales/entities/requirement.entity';
import { SalesFollowupEntity } from '../../sales/entities/sales-followup.entity';
import { SalesActivityEntity } from '../../sales/entities/sales-activity.entity';

const feature = loadFeature('./recruitment-leads.feature', { loadRelativePath: true });
const API = '/api/v1/recruitment';
const FIXTURES = path.join(__dirname, 'fixtures');

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      for (const entity of [...RECRUITMENT_ENTITIES, LeadEntity, RequirementEntity, SalesFollowupEntity, SalesActivityEntity]) {
        const repo: Repository<any> = h.app.get(getRepositoryToken(entity));
        await repo.delete({ organizationId: In(oids) }).catch(() => undefined);
      }
    }
    await h.cleanup();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const api = () => request(h.app.getHttpServer());

  interface Ctx {
    org: CreatedOrg;
    leadId: string;
    requirementId: string;
    candidates: { id: string; name: string }[];
    submissionId?: string;
    res?: request.Response;
    extra: Record<string, any>;
  }

  const newOrg = async () => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  const withLead = async (company: string, positions: number, role: string, skills: string): Promise<Ctx> => {
    const org = await newOrg();
    const lead = (await api().post('/api/v1/sales/leads').set(auth(org.ownerToken)).send({ name: company, company }).expect(201)).body.data;
    const req = (await api().post(`${API}/leads/${lead.id}/requirements`).set(auth(org.ownerToken)).send({
      title: role, role, skills: skills.split(',').map((s) => s.trim()), positions, unit: 'days', quantity: 60, rate: 12000,
    }).expect(201)).body.data;
    return { org, leadId: lead.id, requirementId: req.id, candidates: [], extra: {} };
  };

  const addCandidate = async (ctx: Ctx, name: string, skills: string) => {
    const c = (await api().post(`${API}/candidates`).set(auth(ctx.org.ownerToken)).send({
      fullName: name, skills: skills.split(',').map((s) => s.trim()), totalExpMonths: 72, expectedCtc: 2_520_000,
    }).expect(201)).body.data;
    ctx.candidates.push({ id: c.id, name });
  };

  const submit = async (ctx: Ctx, idx = 0, expect = 201) =>
    api().post(`${API}/submissions`).set(auth(ctx.org.ownerToken))
      .send({ leadId: ctx.leadId, requirementId: ctx.requirementId, candidateId: ctx.candidates[idx].id, billUnit: 'day', billRate: 15000 })
      .expect(expect);

  const move = (ctx: Ctx, status: string, extra: Record<string, unknown> = {}) =>
    api().patch(`${API}/submissions/${ctx.submissionId}/move`).set(auth(ctx.org.ownerToken)).send({ status, ...extra });

  const workspace = async (ctx: Ctx, token = ctx.org.ownerToken) =>
    (await api().get(`${API}/leads/${ctx.leadId}`).set(auth(token)).expect(200)).body.data;

  test('the downloadable sample CVs parse', ({ given, when, then }) => {
    let org: CreatedOrg;
    const parsed: any[] = [];
    given('an organization', async () => { org = await newOrg(); });
    when('the owner uploads the sample CV as PDF and as DOCX and parses them without AI', async () => {
      for (const [file, type] of [
        ['nugenova-sample-cv.pdf', 'application/pdf'],
        ['nugenova-sample-cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ]) {
        const up = await api().post('/api/v1/media/upload').set(auth(org.ownerToken))
          .attach('file', fs.readFileSync(path.join(FIXTURES, file)), { filename: file, contentType: type }).expect(201);
        parsed.push((await api().post(`${API}/candidates/parse`).set(auth(org.ownerToken)).send({ fileId: up.body.data.id, skipAi: true }).expect(201)).body.data);
      }
    });
    then(/^both parses extract the sample email, phone and (\d+) months experience$/, (months: string) => {
      for (const p of parsed) {
        expect(p.parseStatus).not.toBe('no_text');
        expect(p.extracted.email).toBe('aarav.sharma.sample@example.com');
        expect(p.extracted.phone).toBe('+919876501234');
        expect(p.extracted.totalExpMonths).toBe(Number(months));
      }
    });
  });

  test('submitting a candidate to a lead requirement starts work on it', ({ given, and, when, then }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    and(/^a candidate "(.*)" with skills "(.*)"$/, async (name: string, skills: string) => addCandidate(ctx, name, skills));
    when('the owner submits the candidate to that requirement', async () => {
      ctx.res = await submit(ctx);
      ctx.submissionId = ctx.res.body.data.id;
    });
    then(/^the submission is "(.*)" and the requirement is "(.*)"$/, async (status: string, reqStatus: string) => {
      expect(ctx.res!.body.data.status).toBe(status);
      expect(ctx.res!.body.data.requirementTitle).toBe('Senior Data Engineer');
      expect(ctx.res!.body.data.costRate).toBe(10_000); // 25.2L / 12 / 21
      expect(ctx.res!.body.data.marginPct).toBe(33.3);
      const ws = await workspace(ctx);
      expect(ws.requirements[0].status).toBe(reqStatus);
      expect(ws.requirements[0].activeSubmissions).toBe(1);
    });
    and('submitting the same candidate again is rejected as a duplicate', async () => {
      const dup = await submit(ctx, 0, 409);
      expect(dup.body.submissionId ?? dup.body.message?.submissionId).toBe(ctx.submissionId);
    });
  });

  test('the full client path is tracked and fills the requirement', ({ given, and, when, then }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    and(/^a candidate "(.*)" with skills "(.*)"$/, async (name: string, skills: string) => addCandidate(ctx, name, skills));
    and('the candidate is submitted to that requirement', async () => { ctx.submissionId = (await submit(ctx)).body.data.id; });
    when(/^the owner moves the submission straight to "(.*)"$/, async (status: string) => { ctx.res = await move(ctx, status); });
    then('the move is rejected as a bad request', () => { expect(ctx.res!.status).toBe(400); });
    when('the owner withdraws the submission without a reason', async () => { ctx.res = await move(ctx, 'withdrawn'); });
    then('the move is rejected as a bad request', () => { expect(ctx.res!.status).toBe(400); });
    when(/^the owner moves the submission through "(.*)"$/, async (flow: string) => {
      for (const status of flow.split(',').map((s) => s.trim())) {
        await move(ctx, status, status === 'client_selected' ? { clientFeedback: 'Great technical depth' } : {}).expect(200);
      }
    });
    then(/^the requirement is "(.*)" and the submission has (\d+) events$/, async (status: string, n: string) => {
      const ws = await workspace(ctx);
      expect(ws.requirements[0].status).toBe(status);
      const sub = ws.submissions[0];
      expect(sub.status).toBe('onboarded');
      expect(sub.events.map((e: any) => e.toStatus)).toEqual(['shortlisted', 'submitted', 'client_screening', 'client_selected', 'onboarded']);
      expect(sub.events).toHaveLength(Number(n));
      expect(sub.clientFeedback).toContain('Great technical depth');
      expect(sub.decidedAt).toBeTruthy();
    });
    and('the candidate timeline records the client steps', async () => {
      const d = (await api().get(`${API}/candidates/${ctx.candidates[0].id}`).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      const bodies = d.activities.filter((a: any) => a.type === 'submission').map((a: any) => a.body);
      expect(bodies.some((b: string) => /Onboarded — Acme Corp — Senior Data Engineer/.test(b))).toBe(true);
      expect(d.submissions).toHaveLength(1);
    });
    and(/^the lead workspace shows (\d+) onboarded submission$/, async (n: string) => {
      const list = (await api().get(`${API}/leads`).set(auth(ctx.org.ownerToken)).expect(200)).body.data.items;
      expect(list.find((l: any) => l.id === ctx.leadId).submissions.onboarded).toBe(Number(n));
      expect(list.find((l: any) => l.id === ctx.leadId).requirements.positionsOpen).toBe(0);
    });
  });

  test('a client interview is linked to the submission', ({ given, and, when, then }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    and(/^a candidate "(.*)" with skills "(.*)"$/, async (name: string, skills: string) => addCandidate(ctx, name, skills));
    and('the candidate is submitted to that requirement', async () => { ctx.submissionId = (await submit(ctx)).body.data.id; });
    and(/^the owner marks the submission "(.*)"$/, async (status: string) => { await move(ctx, status).expect(200); });
    when('the owner schedules a client interview for the submission', async () => {
      ctx.extra.interview = (await api().post(`${API}/interviews`).set(auth(ctx.org.ownerToken)).send({
        submissionId: ctx.submissionId, roundName: 'Client technical', type: 'video', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        interviewerIds: [ctx.org.ownerId],
      }).expect(201)).body.data;
    });
    then(/^the submission moves to "(.*)"$/, async (status: string) => {
      const sub = (await api().get(`${API}/submissions/${ctx.submissionId}`).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      expect(sub.status).toBe(status);
    });
    and('the interview is a client round labelled with the client', async () => {
      expect(ctx.extra.interview.kind).toBe('client');
      expect(ctx.extra.interview.openingTitle).toBe('Client: Acme Corp');
      const ws = await workspace(ctx);
      expect(ws.interviews).toHaveLength(1);
      expect(ws.interviews[0].submissionId).toBe(ctx.submissionId);
      // Neither or both targets is invalid.
      await api().post(`${API}/interviews`).set(auth(ctx.org.ownerToken)).send({
        roundName: 'x', scheduledAt: new Date().toISOString(), interviewerIds: [ctx.org.ownerId],
      }).expect(400);
    });
  });

  test('lead workspace access is permission-gated and money is masked', ({ given, and, then }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    and(/^a candidate "(.*)" with skills "(.*)"$/, async (name: string, skills: string) => addCandidate(ctx, name, skills));
    and('the candidate is submitted to that requirement', async () => { ctx.submissionId = (await submit(ctx)).body.data.id; });
    then('an employee without recruitment access gets 403 on the lead list', async () => {
      const emp = await h.createEmployeeMember(ctx.org);
      await api().get(`${API}/leads`).set(auth(emp.token)).expect(403);
      await api().post(`${API}/submissions`).set(auth(emp.token)).send({ leadId: ctx.leadId, candidateId: ctx.candidates[0].id }).expect(403);
    });
    and('the owner of another organization gets 404 on the lead', async () => {
      const other = await newOrg();
      await api().get(`${API}/leads/${ctx.leadId}`).set(auth(other.ownerToken)).expect(404);
      await api().get(`${API}/submissions/${ctx.submissionId}`).set(auth(other.ownerToken)).expect(404);
      await api().patch(`${API}/leads/${ctx.leadId}/requirements/${ctx.requirementId}`).set(auth(other.ownerToken)).send({ positions: 9 }).expect(404);
    });
    and('a recruitment view-only member sees no lead value, cost or margin and cannot move the submission', async () => {
      await api().patch(`${API}/leads/${ctx.leadId}`).set(auth(ctx.org.ownerToken)).send({ value: 900000 }).expect(200);
      const role = await api().post('/api/v1/org/roles').set(auth(ctx.org.ownerToken))
        .send({ name: 'rec_viewer', displayName: 'Recruitment viewer', permissions: [{ resource: 'recruitment', actions: ['view'] }] }).expect(201);
      const email = `rec-view-${Date.now()}@example.test`;
      const member = await api().post('/api/v1/org/members').set(auth(ctx.org.ownerToken)).send({ email, roleId: role.body.data.id, firstName: 'View', lastName: 'Only' }).expect(201);
      h.trackUser(member.body.data.userId);
      const token = await h.mintToken(email);
      const ws = await workspace(ctx, token);
      expect(ws.lead.value).toBeNull();
      expect(ws.lead.valueHidden).toBe(true);
      expect(ws.requirements[0].rate).toBeNull();
      expect(ws.submissions[0].costRate).toBeNull();
      expect(ws.submissions[0].marginPct).toBeNull();
      expect(ws.submissions[0].billRate).toBe(15000);
      await api().patch(`${API}/submissions/${ctx.submissionId}/move`).set(auth(token)).send({ status: 'submitted' }).expect(403);
      const ownerWs = await workspace(ctx);
      expect(ownerWs.lead.value).toBe(900000);
    });
  });

  test('the talent pool holds only unassigned candidates', ({ given, and, when, then }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    and(/^a candidate "(.*)" with skills "(.*)"$/, async (name: string, skills: string) => addCandidate(ctx, name, skills));
    and(/^a candidate "(.*)" with skills "(.*)"$/, async (name: string, skills: string) => addCandidate(ctx, name, skills));
    and('the first candidate is submitted to that requirement', async () => { await submit(ctx, 0); });
    when('the owner lists the talent pool', async () => {
      ctx.res = await api().get(`${API}/candidates`).query({ pool: 'unassigned' }).set(auth(ctx.org.ownerToken)).expect(200);
    });
    then(/^only "(.*)" is in the talent pool and the pool counts agree$/, async (name: string) => {
      expect(ctx.res!.body.data.items.map((c: any) => c.fullName)).toEqual([name]);
      const counts = (await api().get(`${API}/candidates/pool-counts`).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      expect(counts).toEqual({ all: 2, unassigned: 1, pipeline: 0, submitted: 1, placed: 0 });
      const submitted = (await api().get(`${API}/candidates`).query({ pool: 'submitted' }).set(auth(ctx.org.ownerToken)).expect(200)).body.data.items;
      expect(submitted[0].submissions[0]).toMatchObject({ leadName: 'Acme Corp', status: 'shortlisted', active: true });
    });
  });

  test('suggestions rank the best-fitting requirement first', ({ given, and, when, then }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    and(/^the lead also needs a "(.*)" with skills "(.*)"$/, async (role: string, skills: string) => {
      ctx.extra.frontendReq = (await api().post(`${API}/leads/${ctx.leadId}/requirements`).set(auth(ctx.org.ownerToken))
        .send({ title: role, role, skills: skills.split(',').map((s) => s.trim()) }).expect(201)).body.data.id;
    });
    and(/^a candidate "(.*)" with skills "(.*)"$/, async (name: string, skills: string) => addCandidate(ctx, name, skills));
    when('the owner asks for suggestions for the candidate', async () => {
      ctx.res = await api().get(`${API}/candidates/${ctx.candidates[0].id}/suggestions`).set(auth(ctx.org.ownerToken)).expect(200);
    });
    then(/^the first suggestion is the "(.*)" requirement$/, (role: string) => {
      const [first] = ctx.res!.body.data;
      expect(first).toMatchObject({ type: 'requirement', title: role, leadId: ctx.leadId, requirementId: ctx.extra.frontendReq });
      expect(first.score).toBeGreaterThanOrEqual(60);
      expect(first.reasons.join(' ')).toMatch(/2\/2 skills/);
      expect(ctx.res!.body.data.some((s: any) => s.title === 'Senior Data Engineer')).toBe(false);
    });
    and(/^matches for that requirement rank "(.*)" first$/, async (name: string) => {
      const m = (await api().get(`${API}/matches`).query({ requirementId: ctx.extra.frontendReq }).set(auth(ctx.org.ownerToken)).expect(200)).body.data;
      expect(m[0].candidate.fullName).toBe(name);
      expect(m[0].linked).toBeNull();
      const pool = (await api().get(`${API}/candidates`).query({ pool: 'unassigned' }).set(auth(ctx.org.ownerToken)).expect(200)).body.data.items;
      expect(pool[0].topSuggestion).toMatchObject({ title: 'Frontend Developer' });
    });
  });

  test('an opening can be raised from a requirement', ({ given, when, then, and }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    when('the owner creates an opening from the requirement', async () => {
      ctx.res = await api().post(`${API}/leads/${ctx.leadId}/requirements/${ctx.requirementId}/opening`).set(auth(ctx.org.ownerToken)).expect(201);
    });
    then("the opening carries the requirement's skills and is linked to the lead", async () => {
      const o = ctx.res!.body.data;
      expect(o.title).toBe('Senior Data Engineer (Acme Corp)');
      expect(o.skills).toEqual(['PySpark', 'SQL']);
      expect(o.leadId).toBe(ctx.leadId);
      const ws = await workspace(ctx);
      expect(ws.openings).toEqual([expect.objectContaining({ id: o.id, requirementId: ctx.requirementId })]);
    });
    and('creating it again is rejected as a conflict', async () => {
      await api().post(`${API}/leads/${ctx.leadId}/requirements/${ctx.requirementId}/opening`).set(auth(ctx.org.ownerToken)).expect(409);
    });
  });

  test('importing rows with a Lead column shortlists them and fills the talent pool', ({ given, when, then, and }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    when('the owner imports one row for the lead requirement and one row with no opening or lead', async () => {
      const rows = [
        { rowNumber: 2, fullName: 'Kiran Rao', email: 'kiran.rao.sample@example.com', experience: '7 years', lead: 'acme corp', requirement: 'Senior Data Engineer' },
        { rowNumber: 3, fullName: 'Pool Person', email: 'pool.person.sample@example.com', experience: '3 years' },
        { rowNumber: 4, fullName: 'Ghost Lead', email: 'ghost.sample@example.com', lead: 'No Such Client' },
      ];
      const dry = (await api().post(`${API}/candidates/import`).set(auth(ctx.org.ownerToken)).send({ rows, dryRun: true }).expect(201)).body.data;
      expect(dry.summary.submissions).toBe(1);
      ctx.res = await api().post(`${API}/candidates/import`).set(auth(ctx.org.ownerToken)).send({ rows }).expect(201);
    });
    then(/^the import reports (\d+) submission and (\d+) talent-pool candidate$/, (subs: string, pool: string) => {
      const { summary, results } = ctx.res!.body.data;
      expect(summary.submissions).toBe(Number(subs));
      // "Ghost Lead" names an unknown lead, so it also stays in the pool.
      expect(summary.talentPool).toBe(Number(pool) + 1);
      expect(results[2].messages.join(' ')).toMatch(/Lead “No Such Client” not found/);
    });
    and(/^the lead workspace lists the imported candidate as "(.*)"$/, async (status: string) => {
      const ws = await workspace(ctx);
      expect(ws.submissions.map((s: any) => [s.candidate.fullName, s.status])).toEqual([['Kiran Rao', status]]);
    });
  });

  test('lead details, requirements, follow-ups and notes are managed from Recruitment', ({ given, when, then }) => {
    let ctx: Ctx;
    given(/^an organization with a lead "(.*)" needing (\d+) "(.*)" with skills "(.*)"$/, async (c: string, n: string, r: string, s: string) => { ctx = await withLead(c, Number(n), r, s); });
    when(/^the owner edits the requirement to (\d+) positions needed by "(.*)" and adds a follow-up and a call note$/, async (n: string, date: string) => {
      await api().patch(`${API}/leads/${ctx.leadId}/requirements/${ctx.requirementId}`).set(auth(ctx.org.ownerToken)).send({ positions: Number(n), neededBy: date }).expect(200);
      await api().post(`${API}/leads/${ctx.leadId}/followups`).set(auth(ctx.org.ownerToken)).send({ dueAt: '2026-11-01T10:00:00.000Z', note: 'Share 3 profiles' }).expect(201);
      await api().post(`${API}/leads/${ctx.leadId}/notes`).set(auth(ctx.org.ownerToken)).send({ type: 'call', body: 'Client wants PySpark depth' }).expect(201);
    });
    then(/^the lead workspace shows the requirement with (\d+) positions, the follow-up and the note$/, async (n: string) => {
      const ws = await workspace(ctx);
      expect(ws.requirements[0].positions).toBe(Number(n));
      expect(new Date(ws.requirements[0].neededBy).toISOString().slice(0, 10)).toBe('2026-12-01');
      expect(ws.followups.map((f: any) => f.note)).toEqual(['Share 3 profiles']);
      expect(ws.notes.map((x: any) => x.body)).toEqual(['Client wants PySpark depth']);
      expect(ws.lead.nextFollowUpAt).toBeTruthy();
    });
  });

  test('one candidate runs in several client leads at different stages at the same time', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    const leads: { leadId: string; requirementId: string }[] = [];
    let candidateId: string;
    const subIds: string[] = [];
    given(/^an organization with (\d+) client leads each needing a "(.*)"$/, async (n: string, role: string) => {
      org = await newOrg();
      for (let i = 0; i < Number(n); i++) {
        const lead = (await api().post('/api/v1/sales/leads').set(auth(org.ownerToken)).send({ name: `Client ${i + 1}`, company: `Client ${i + 1}` }).expect(201)).body.data;
        const req = (await api().post(`${API}/leads/${lead.id}/requirements`).set(auth(org.ownerToken)).send({ title: role, role, skills: ['PySpark'] }).expect(201)).body.data;
        leads.push({ leadId: lead.id, requirementId: req.id });
      }
    });
    and(/^a candidate "(.*)" with skills "(.*)" in that organization$/, async (name: string, skills: string) => {
      candidateId = (await api().post(`${API}/candidates`).set(auth(org.ownerToken)).send({ fullName: name, skills: skills.split(',').map((x) => x.trim()) }).expect(201)).body.data.id;
    });
    when(/^the owner submits the candidate to all (\d+) leads$/, async () => {
      for (const l of leads) {
        subIds.push((await api().post(`${API}/submissions`).set(auth(org.ownerToken)).send({ ...l, candidateId, status: 'submitted' }).expect(201)).body.data.id);
      }
    });
    and(/^moves (\d+) of them to "(.*)" and (\d+) to "(.*)"$/, async (a: string, s1: string, b: string, s2: string) => {
      for (let i = 0; i < Number(a); i++) await api().patch(`${API}/submissions/${subIds[i]}/move`).set(auth(org.ownerToken)).send({ status: s1 }).expect(200);
      for (let i = Number(a); i < Number(a) + Number(b); i++) await api().patch(`${API}/submissions/${subIds[i]}/move`).set(auth(org.ownerToken)).send({ status: s2 }).expect(200);
    });
    then(/^the candidate profile shows (\d+) active submissions with (\d+) in "(.*)" and (\d+) in "(.*)"$/, async (total: string, a: string, s1: string, b: string, s2: string) => {
      const d = (await api().get(`${API}/candidates/${candidateId}`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(d.submissions).toHaveLength(Number(total));
      expect(new Set(d.submissions.map((x: any) => x.leadId)).size).toBe(Number(total));
      expect(d.submissions.filter((x: any) => x.status === s1)).toHaveLength(Number(a));
      expect(d.submissions.filter((x: any) => x.status === s2)).toHaveLength(Number(b));
    });
    and(/^the candidate appears once in the "(.*)" pool with all (\d+) submissions$/, async (pool: string, n: string) => {
      const items = (await api().get(`${API}/candidates`).query({ pool }).set(auth(org.ownerToken)).expect(200)).body.data.items;
      expect(items).toHaveLength(1);
      expect(items[0].submissions).toHaveLength(Number(n));
      expect(items[0].submissions.every((x: any) => x.active)).toBe(true);
    });
  });

  test('the import preview flags duplicates by name, email and phone before anything is saved', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let existingId: string;
    let data: any;
    given(/^an organization with an existing candidate "(.*)" with email "(.*)" and phone "(.*)"$/, async (name: string, email: string, phone: string) => {
      org = await newOrg();
      existingId = (await api().post(`${API}/candidates`).set(auth(org.ownerToken)).send({ fullName: name, email, phone }).expect(201)).body.data.id;
    });
    when('the owner previews an import with rows matching by email, by phone, by name only and repeating within the file', async () => {
      const rows = [
        { rowNumber: 2, fullName: 'A. Shaw', email: 'AKASH.sample@example.com' },
        { rowNumber: 3, fullName: 'Akash S', phone: '+91 98047 53101' },
        { rowNumber: 4, fullName: 'Akash Shaw', email: 'another.akash@example.com', phone: '9000000001' },
        { rowNumber: 5, fullName: 'Neha Kapoor', email: 'neha.sample@example.com' },
        { rowNumber: 6, fullName: 'Neha K.', email: 'neha.sample@example.com' },
      ];
      data = (await api().post(`${API}/candidates/import`).set(auth(org.ownerToken)).send({ rows, dryRun: true }).expect(201)).body.data;
    });
    then(/^the preview marks the email and phone rows as merged into "(.*)"$/, (name: string) => {
      expect(data.results[0].duplicate).toMatchObject({ kind: 'existing', action: 'merged', matchedOn: ['email'], candidateId: existingId, fullName: name });
      expect(data.results[1].duplicate).toMatchObject({ kind: 'existing', action: 'merged', matchedOn: ['phone'], candidateId: existingId });
    });
    and('the name-only row is flagged for review', () => {
      expect(data.results[2].outcome).toBe('created');
      expect(data.results[2].duplicate).toMatchObject({ kind: 'existing', action: 'flagged', matchedOn: ['name'], candidateId: existingId });
    });
    and('the repeated row is marked as the same person as its earlier row', () => {
      expect(data.results[3].duplicate).toBeNull();
      expect(data.results[4].duplicate).toMatchObject({ kind: 'file', action: 'merged', row: 5, matchedOn: ['email'] });
    });
    and(/^the summary counts (\d+) merged and (\d+) flagged duplicates with nothing saved$/, async (m: string, f: string) => {
      expect(data.summary.duplicatesMerged).toBe(Number(m));
      expect(data.summary.duplicatesFlagged).toBe(Number(f));
      const list = (await api().get(`${API}/candidates`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(list.total).toBe(1);
    });
  });
});
