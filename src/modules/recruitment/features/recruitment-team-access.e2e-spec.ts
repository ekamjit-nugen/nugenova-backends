import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness } from '../../organization/features/support/org-harness';
import { AiUsageEventEntity } from '../../ai/entities/ai-usage-event.entity';
import { RECRUITMENT_ENTITIES } from '../entities';

const feature = loadFeature('./recruitment-team-access.feature', { loadRelativePath: true });
const API = '/api/v1/recruitment';

/** A small but real PDF-shaped buffer; the content is irrelevant — it is stored and served as-is. */
const pdfBytes = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);

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
  const uniq = () => Math.random().toString(36).slice(2, 8);
  const binary = (req: request.Test) => req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  interface Ctx {
    org: CreatedOrg;
    recruiter: string;
    candidateId?: string;
    files: Record<string, { fileId: string; docId?: string; bytes: Buffer }>;
    viewer?: string;
  }

  const memberWith = async (org: CreatedOrg, actions: string[], label: string) => {
    const role = await api().post('/api/v1/org/roles').set(auth(org.ownerToken))
      .send({ name: `rec_${label}_${uniq()}`, displayName: `Recruitment ${label}`, permissions: [{ resource: 'recruitment', actions }] }).expect(201);
    const email = `rec-${label}-${uniq()}@example.test`;
    const member = await api().post('/api/v1/org/members').set(auth(org.ownerToken)).send({ email, roleId: role.body.data.id, firstName: 'Team', lastName: label }).expect(201);
    h.trackUser(member.body.data.userId);
    return h.mintToken(email);
  };

  const withRecruiter = async (): Promise<Ctx> => {
    const org = await h.createOrg();
    orgIds.add(org.orgId);
    return { org, recruiter: await memberWith(org, ['view', 'create', 'edit', 'delete'], 'recruiter'), files: {} };
  };

  const createCandidate = async (ctx: Ctx, fullName: string, extra: Record<string, unknown> = {}) => {
    ctx.candidateId = (await api().post(`${API}/candidates`).set(auth(ctx.recruiter)).send({ fullName, ...extra }).expect(201)).body.data.id;
  };

  const uploadFile = async (ctx: Ctx, name: string, bytes: Buffer, type = 'application/pdf', token = ctx.recruiter) => {
    const up = await api().post('/api/v1/media/upload').set(auth(token)).attach('file', bytes, { filename: name, contentType: type }).expect(201);
    ctx.files[name] = { fileId: up.body.data.id, bytes };
    return up.body.data.id as string;
  };

  const attachCv = async (ctx: Ctx, name: string, bytes: Buffer) => {
    const fileId = await uploadFile(ctx, name, bytes);
    const doc = (await api().post(`${API}/candidates/${ctx.candidateId}/documents`).set(auth(ctx.recruiter)).send({ fileId, kind: 'resume' }).expect(201)).body.data;
    ctx.files[name].docId = doc.id;
    return doc;
  };

  const detail = async (ctx: Ctx, token = ctx.recruiter) =>
    (await api().get(`${API}/candidates/${ctx.candidateId}`).set(auth(token)).expect(200)).body.data;

  const resumes = async (ctx: Ctx) => (await detail(ctx)).documents.filter((d: any) => d.kind === 'resume');

  test('a recruiter manages a candidate end to end', ({ given, when, then }) => {
    let ctx: Ctx;
    given('an organization with a recruiter who can view, create, edit and delete candidates', async () => { ctx = await withRecruiter(); });
    when(/^the recruiter creates the candidate "(.*)" with email "(.*)"$/, async (name: string, email: string) => {
      await createCandidate(ctx, name, { email });
    });
    then(/^the candidate is listed and found by searching "(.*)"$/, async (q: string) => {
      const all = (await api().get(`${API}/candidates`).set(auth(ctx.recruiter)).expect(200)).body.data;
      expect(all.items.map((c: any) => c.id)).toContain(ctx.candidateId);
      const found = (await api().get(`${API}/candidates`).query({ q }).set(auth(ctx.recruiter)).expect(200)).body.data;
      expect(found.items.map((c: any) => c.id)).toEqual([ctx.candidateId]);
    });
    when(/^the recruiter updates the candidate's company to "(.*)", notice to (\d+) days and status to "(.*)"$/, async (company: string, days: string, status: string) => {
      await api().patch(`${API}/candidates/${ctx.candidateId}`).set(auth(ctx.recruiter))
        .send({ currentCompany: company, noticePeriodDays: Number(days), noticeStatus: 'serving', status }).expect(200);
    });
    then('the profile shows the new company, notice and status', async () => {
      const c = (await detail(ctx)).candidate;
      expect(c.currentCompany).toBe('Acme Analytics');
      expect(c.noticePeriodDays).toBe(30);
      expect(c.status).toBe('on_hold');
    });
    when('the recruiter deletes the candidate', async () => {
      await api().delete(`${API}/candidates/${ctx.candidateId}`).set(auth(ctx.recruiter)).expect(200);
    });
    then('the candidate is gone from the list and their profile returns 404', async () => {
      const all = (await api().get(`${API}/candidates`).query({ status: 'on_hold' }).set(auth(ctx.recruiter)).expect(200)).body.data;
      expect(all.items.map((c: any) => c.id)).not.toContain(ctx.candidateId);
      await api().get(`${API}/candidates/${ctx.candidateId}`).set(auth(ctx.recruiter)).expect(404);
    });
  });

  test('a recruiter uploads CVs, replaces them with a new version and views them in the portal', ({ given, and, when, then }) => {
    let ctx: Ctx;
    given('an organization with a recruiter who can view, create, edit and delete candidates', async () => { ctx = await withRecruiter(); });
    and(/^the recruiter has a candidate "(.*)"$/, async (name: string) => createCandidate(ctx, name));
    when(/^the recruiter uploads "(.*)" as the CV$/, async (name: string) => { await attachCv(ctx, name, pdfBytes(name)); });
    and(/^the recruiter uploads "(.*)" as a new CV$/, async (name: string) => { await attachCv(ctx, name, pdfBytes(name)); });
    then(/^the candidate has (\d+) CV versions with "(.*)" as primary$/, async (n: string, name: string) => {
      const docs = await resumes(ctx);
      expect(docs).toHaveLength(Number(n));
      expect(docs.find((d: any) => d.isPrimary).fileName).toBe(name);
      expect(docs.map((d: any) => d.version).sort()).toEqual([1, 2]);
    });
    and('each CV opens in the portal with the bytes that were uploaded', async () => {
      for (const f of Object.values(ctx.files)) {
        const res = await binary(api().get(`${API}/candidates/${ctx.candidateId}/documents/${f.docId}/file`).set(auth(ctx.recruiter))).expect(200);
        expect(res.headers['content-type']).toMatch(/application\/pdf/);
        expect(res.headers['content-disposition']).toMatch(/^inline/);
        expect(Buffer.compare(res.body as Buffer, f.bytes)).toBe(0);
      }
    });
    when(/^the recruiter makes "(.*)" the primary CV again$/, async (name: string) => {
      await api().post(`${API}/candidates/${ctx.candidateId}/documents/${ctx.files[name].docId}/primary`).set(auth(ctx.recruiter)).expect(201);
    });
    then(/^"(.*)" is the primary CV$/, async (name: string) => {
      expect((await resumes(ctx)).find((d: any) => d.isPrimary).fileName).toBe(name);
    });
    when(/^the recruiter removes "(.*)"$/, async (name: string) => {
      await api().delete(`${API}/candidates/${ctx.candidateId}/documents/${ctx.files[name].docId}`).set(auth(ctx.recruiter)).expect(200);
    });
    then(/^"(.*)" becomes the primary CV$/, async (name: string) => {
      const docs = await resumes(ctx);
      expect(docs).toHaveLength(1);
      expect(docs[0].fileName).toBe(name);
      expect(docs[0].isPrimary).toBe(true);
    });
    and('no profile details were filled in from the CVs and no AI was used', async () => {
      const c = (await detail(ctx)).candidate;
      expect(c.email).toBeNull();
      expect(c.totalExpMonths).toBeNull();
      expect(c).not.toHaveProperty('aiSummary');
      const usage: Repository<AiUsageEventEntity> = h.app.get(getRepositoryToken(AiUsageEventEntity));
      expect(await usage.count({ where: { organizationId: ctx.org.orgId } })).toBe(0);
    });
  });

  test('a CV with unusual bytes still uploads', ({ given, and, when, then }) => {
    let ctx: Ctx;
    let bytes: Buffer;
    given('an organization with a recruiter who can view, create, edit and delete candidates', async () => { ctx = await withRecruiter(); });
    and(/^the recruiter has a candidate "(.*)"$/, async (name: string) => createCandidate(ctx, name));
    when('the recruiter uploads a CV whose content contains NUL bytes', async () => {
      bytes = Buffer.concat([pdfBytes('heading'), Buffer.from([0, 0, 0, 0, 83, 0, 0, 67, 0, 0]), Buffer.from('ANMOL KUMAR SHARMA\n')]);
      await attachCv(ctx, 'Cutshort-ANMOL-KUMARSHARMA-8vup.pdf', bytes);
    });
    then('the CV is attached as primary and opens with identical bytes', async () => {
      const docs = await resumes(ctx);
      expect(docs).toHaveLength(1);
      expect(docs[0].isPrimary).toBe(true);
      const res = await binary(api().get(`${API}/candidates/${ctx.candidateId}/documents/${docs[0].id}/file`).set(auth(ctx.recruiter))).expect(200);
      expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
    });
  });

  test('a candidate can be created together with their CV', ({ given, when, then }) => {
    let ctx: Ctx;
    let fileName: string;
    given('an organization with a recruiter who can view, create, edit and delete candidates', async () => { ctx = await withRecruiter(); });
    when(/^the recruiter uploads "(.*)" and saves "(.*)" with phone "(.*)" from it$/, async (file: string, name: string, phone: string) => {
      fileName = file;
      const fileId = await uploadFile(ctx, file, pdfBytes(file));
      // The upload screen previews the CV before it is saved.
      expect((await api().get(`${API}/candidates/files/${fileId}/preview`).set(auth(ctx.recruiter)).expect(200)).body.data).toEqual({ kind: 'file', html: null });
      const res = await api().post(`${API}/candidates/from-cv`).set(auth(ctx.recruiter)).send({ fileId, data: { fullName: name, phone } }).expect(201);
      expect(res.body.data.created).toBe(true);
      ctx.candidateId = res.body.data.candidate.id;
    });
    then(/^"(.*)" exists with that phone, a Cutshort source and the CV as primary$/, async (name: string) => {
      const d = await detail(ctx);
      expect(d.candidate.fullName).toBe(name);
      expect(d.candidate.phone).toBe('+919876512345');
      expect(d.candidate.source).toBe('cutshort');
      expect(d.documents).toHaveLength(1);
      expect(d.documents[0]).toMatchObject({ fileName, isPrimary: true, kind: 'resume' });
    });
  });

  test('viewers can read and open CVs but not change anything', ({ given, and, then }) => {
    let ctx: Ctx;
    let docId: string;
    given('an organization with a recruiter who can view, create, edit and delete candidates', async () => { ctx = await withRecruiter(); });
    and(/^the recruiter has a candidate "(.*)" with a CV$/, async (name: string) => {
      await createCandidate(ctx, name);
      docId = (await attachCv(ctx, 'cv.pdf', pdfBytes('viewer'))).id;
    });
    and('a teammate who can only view recruitment', async () => { ctx.viewer = await memberWith(ctx.org, ['view'], 'viewer'); });
    then('the viewer can list the candidate, open the profile and open the CV', async () => {
      const list = (await api().get(`${API}/candidates`).set(auth(ctx.viewer!)).expect(200)).body.data;
      expect(list.items.map((c: any) => c.id)).toContain(ctx.candidateId);
      expect((await detail(ctx, ctx.viewer!)).documents).toHaveLength(1);
      const res = await binary(api().get(`${API}/candidates/${ctx.candidateId}/documents/${docId}/file`).set(auth(ctx.viewer!))).expect(200);
      expect(Buffer.compare(res.body as Buffer, ctx.files['cv.pdf'].bytes)).toBe(0);
    });
    and('the viewer cannot create, update, delete, upload or remove a CV', async () => {
      const v = ctx.viewer!;
      await api().post(`${API}/candidates`).set(auth(v)).send({ fullName: 'Nope' }).expect(403);
      await api().patch(`${API}/candidates/${ctx.candidateId}`).set(auth(v)).send({ currentCompany: 'Nope' }).expect(403);
      await api().delete(`${API}/candidates/${ctx.candidateId}`).set(auth(v)).expect(403);
      const fileId = await uploadFile(ctx, 'viewer-cv.pdf', pdfBytes('viewer upload'), 'application/pdf', v);
      await api().post(`${API}/candidates/${ctx.candidateId}/documents`).set(auth(v)).send({ fileId, kind: 'resume' }).expect(403);
      await api().get(`${API}/candidates/files/${fileId}/preview`).set(auth(v)).expect(403);
      await api().post(`${API}/candidates/from-cv`).set(auth(v)).send({ fileId, data: { fullName: 'Nope' } }).expect(403);
      await api().post(`${API}/candidates/${ctx.candidateId}/documents/${docId}/primary`).set(auth(v)).expect(403);
      await api().delete(`${API}/candidates/${ctx.candidateId}/documents/${docId}`).set(auth(v)).expect(403);
      expect((await detail(ctx)).documents).toHaveLength(1);
    });
  });

  test('people outside recruitment or the organization cannot reach candidates or CVs', ({ given, and, then }) => {
    let ctx: Ctx;
    let docId: string;
    given('an organization with a recruiter who can view, create, edit and delete candidates', async () => { ctx = await withRecruiter(); });
    and(/^the recruiter has a candidate "(.*)" with a CV$/, async (name: string) => {
      await createCandidate(ctx, name);
      docId = (await attachCv(ctx, 'cv.pdf', pdfBytes('private'))).id;
    });
    then('an employee without recruitment access gets 403 on candidates and the CV', async () => {
      const emp = await h.createEmployeeMember(ctx.org);
      await api().get(`${API}/candidates`).set(auth(emp.token)).expect(403);
      await api().post(`${API}/candidates`).set(auth(emp.token)).send({ fullName: 'Nope' }).expect(403);
      await api().get(`${API}/candidates/${ctx.candidateId}/documents/${docId}/file`).set(auth(emp.token)).expect((res) => expect([403, 404]).toContain(res.status));
      await api().get(`${API}/candidates/${ctx.candidateId}/documents/${docId}/preview`).set(auth(emp.token)).expect((res) => expect([403, 404]).toContain(res.status));
    });
    and('the owner of another organization gets 404 on the candidate and the CV', async () => {
      const other = await h.createOrg();
      orgIds.add(other.orgId);
      await api().get(`${API}/candidates/${ctx.candidateId}`).set(auth(other.ownerToken)).expect(404);
      await api().get(`${API}/candidates/${ctx.candidateId}/documents/${docId}/file`).set(auth(other.ownerToken)).expect(404);
      await api().get(`${API}/candidates/${ctx.candidateId}/documents/${docId}/preview`).set(auth(other.ownerToken)).expect(404);
      await api().patch(`${API}/candidates/${ctx.candidateId}`).set(auth(other.ownerToken)).send({ currentCompany: 'x' }).expect(404);
      await api().delete(`${API}/candidates/${ctx.candidateId}`).set(auth(other.ownerToken)).expect(404);
    });
  });
});
