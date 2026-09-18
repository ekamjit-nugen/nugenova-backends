import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness } from '../../organization/features/support/org-harness';
import { RECRUITMENT_ENTITIES, RecruitmentImportJobEntity, RecruitmentImportRowEntity } from '../entities';
import { ImportJobsService } from '../services/import-jobs.service';

const feature = loadFeature('./recruitment-import-jobs.feature', { loadRelativePath: true });
const API = '/api/v1/recruitment';
const FINISHED = ['completed', 'failed', 'cancelled'];

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
  const newOrg = async () => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };
  const key = () => `k${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
  const uniq = () => Math.random().toString(36).slice(2, 8);

  const start = (org: CreatedOrg, body: Record<string, unknown>, token = org.ownerToken) =>
    api().post(`${API}/imports`).set(auth(token)).send({ fileName: 'Candidates.xlsx', idempotencyKey: key(), ...body });

  const waitDone = async (org: CreatedOrg, id: string, timeoutMs = 45_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const job = (await api().get(`${API}/imports/${id}`).set(auth(org.ownerToken)).expect(200)).body.data;
      if (FINISHED.includes(job.status)) return job;
      if (Date.now() > until) throw new Error(`import ${id} still ${job.status} (${job.processedRows}/${job.totalRows})`);
      await h.app.get(ImportJobsService).tick();
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const candidateCount = async (org: CreatedOrg) =>
    (await api().get(`${API}/candidates?limit=1`).set(auth(org.ownerToken)).expect(200)).body.data.total as number;

  const viewOnlyMember = async (org: CreatedOrg) => {
    const role = await api().post('/api/v1/org/roles').set(auth(org.ownerToken))
      .send({ name: `rec_view_${uniq()}`, displayName: 'Recruitment viewer', permissions: [{ resource: 'recruitment', actions: ['view'] }] }).expect(201);
    const email = `rec-view-${uniq()}@example.test`;
    const member = await api().post('/api/v1/org/members').set(auth(org.ownerToken)).send({ email, roleId: role.body.data.id, firstName: 'View', lastName: 'Only' }).expect(201);
    h.trackUser(member.body.data.userId);
    return h.mintToken(email);
  };

  test('starting an import answers at once and saves rows in the background', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let res: request.Response;
    let job: any;
    const u = uniq();
    given('an organization', async () => { org = await newOrg(); });
    when(/^the owner starts importing "(.*)" with 12 valid rows, a repeated row, a total line, a row without contact details and a row with an invalid email$/, async (file: string) => {
      const extra = Array.from({ length: 9 }, (_, i) => ({ sheet: 'Data', rowNumber: 9 + i, fullName: `Extra Person ${i}`, email: `extra${i}.${u}@example.com` }));
      res = await start(org, {
        fileName: file,
        rows: [
          { sheet: 'Data', rowNumber: 2, fullName: 'Asha Rao', email: `asha.${u}@example.com`, phone: '9876500011' },
          { sheet: 'Data', rowNumber: 3, fullName: 'Vikram Singh', phone: `98765${u.replace(/\D/g, '').padEnd(5, '1').slice(0, 5)}` },
          { sheet: 'Data', rowNumber: 4, fullName: 'Neha Jain', resumeUrl: 'https://drive.example.com/neha.pdf' },
          { sheet: 'Data', rowNumber: 5, fullName: 'ASHA RAO', email: `asha.${u}@example.com` },
          { sheet: 'Data', rowNumber: 6, fullName: 'Total candidates in this sheet: 4' },
          { sheet: 'Data', rowNumber: 7, fullName: 'Rohit Nair', experience: '5 years' },
          { sheet: 'Data', rowNumber: 8, fullName: 'Pooja Shah', email: 'not-an-email', resumeUrl: '..\\\\Resume_Library\\\\pooja.pdf' },
          ...extra,
        ],
      });
    });
    then('the import is accepted immediately as queued or processing', async () => {
      expect(res.status).toBe(202);
      job = res.body.data;
      expect(['queued', 'processing', 'completed']).toContain(job.status);
      expect(job.totalRows).toBe(16);
      expect(res.body.duplicate).toBe(false);
    });
    and(/^the import finishes with (\d+) new, (\d+) merged, (\d+) ignored and (\d+) errors out of (\d+) rows$/, async (n: string, m: string, s: string, e: string, total: string) => {
      job = await waitDone(org, job.id);
      expect(job.status).toBe('completed');
      expect(job.processedRows).toBe(Number(total));
      expect(job.counts.created).toBe(Number(n));
      expect(job.counts.merged).toBe(Number(m));
      expect(job.counts.skipped).toBe(Number(s));
      expect(job.counts.errors).toBe(Number(e));
      expect(job.counts.talentPool).toBe(12);
      expect(await candidateCount(org)).toBe(12);
    });
    and(/^the import list shows "(.*)" at 100 percent$/, async (file: string) => {
      const list = (await api().get(`${API}/imports`).set(auth(org.ownerToken)).expect(200)).body.data;
      const row = list.find((j: any) => j.id === job.id);
      expect(row.fileName).toBe(file);
      expect(row.progressPct).toBe(100);
      expect(row.createdByName).toBeTruthy();
    });
    and('every ignored row says why it was ignored', async () => {
      const rows = (await api().get(`${API}/imports/${job.id}/rows?filter=skipped`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(rows.total).toBe(3);
      const byRow = Object.fromEntries(rows.items.map((r: any) => [r.rowNumber, r.messages.join(' | ')]));
      expect(byRow[6]).toMatch(/sheet note/i);
      expect(byRow[7]).toMatch(/no email, phone, CV link or LinkedIn/i);
      expect(byRow[8]).toMatch(/not a valid email address/i);
    });
  });

  test('sending the same import again does not import twice', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let a: request.Response;
    let b: request.Response;
    given('an organization', async () => { org = await newOrg(); });
    when('the owner starts the same import twice with one idempotency key', async () => {
      const u = uniq();
      const body = {
        idempotencyKey: key(),
        rows: [
          { fullName: 'Kiran Das', email: `kiran.${u}@example.com` },
          { fullName: 'Meena Iyer', email: `meena.${u}@example.com` },
        ],
      };
      [a, b] = await Promise.all([start(org, body), start(org, body)]);
    });
    then('both requests return the same import', async () => {
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(a.body.data.id).toBe(b.body.data.id);
      expect([a.body.duplicate, b.body.duplicate].filter(Boolean)).toHaveLength(1);
    });
    and(/^the organization has exactly (\d+) candidates once it finishes$/, async (n: string) => {
      await waitDone(org, a.body.data.id);
      expect(await candidateCount(org)).toBe(Number(n));
      const list = (await api().get(`${API}/imports`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(list).toHaveLength(1);
    });
  });

  test('parallel imports create a new opening only once', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let ids: string[] = [];
    given('an organization', async () => { org = await newOrg(); });
    when(/^the owner starts two imports at the same time that both use the new opening "(.*)"$/, async (opening: string) => {
      const u = uniq();
      const mk = (p: string) => [1, 2].map((i) => ({ fullName: `${p} Person ${i}`, email: `${p.toLowerCase()}${i}.${u}@example.com`, opening }));
      const [x, y] = await Promise.all([start(org, { rows: mk('Alpha') }), start(org, { rows: mk('Beta') })]);
      ids = [x.body.data.id, y.body.data.id];
    });
    then('both imports finish', async () => {
      for (const id of ids) expect((await waitDone(org, id)).status).toBe('completed');
    });
    and(/^the organization has one "(.*)" opening holding all (\d+) candidates$/, async (title: string, n: string) => {
      const openings = (await api().get(`${API}/openings`).set(auth(org.ownerToken)).expect(200)).body.data;
      const list = (Array.isArray(openings) ? openings : openings.items).filter((o: any) => o.title === title);
      expect(list).toHaveLength(1);
      const cands = (await api().get(`${API}/candidates?openingId=${list[0].id}&limit=50`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(cands.total).toBe(Number(n));
    });
  });

  test('an interrupted import resumes without duplicating saved rows', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let jobId: string;
    let savedEmail: string;
    given('an organization', async () => { org = await newOrg(); });
    and('an import whose worker stopped after saving the first of 3 rows', async () => {
      const u = uniq();
      savedEmail = `saved.${u}@example.com`;
      const saved = (await api().post(`${API}/candidates`).set(auth(org.ownerToken)).send({ fullName: 'Saved Person', email: savedEmail }).expect(201)).body.data;
      const jobs: Repository<RecruitmentImportJobEntity> = h.app.get(getRepositoryToken(RecruitmentImportJobEntity));
      const rows: Repository<RecruitmentImportRowEntity> = h.app.get(getRepositoryToken(RecruitmentImportRowEntity));
      const me = (await api().get('/api/v1/auth/me').set(auth(org.ownerToken)).expect(200)).body.data;
      const job = await jobs.save(jobs.create({
        organizationId: org.orgId, createdBy: me.id ?? me.userId ?? org.ownerId,
        caller: { userId: org.ownerId, orgId: org.orgId, isAdmin: true, actions: [] },
        fileName: 'Crashed.xlsx', status: 'processing', lockedBy: 'dead-worker', heartbeatAt: new Date(Date.now() - 10 * 60_000),
        startedAt: new Date(Date.now() - 11 * 60_000), attempts: 1, totalRows: 3, options: {},
      }));
      jobId = job.id;
      await rows.save([
        rows.create({ organizationId: org.orgId, jobId, idx: 0, payload: { fullName: 'Saved Person', email: savedEmail }, status: 'done', outcome: 'created', candidateId: saved.id, fullName: 'Saved Person', processedAt: new Date(), talentPool: true }),
        rows.create({ organizationId: org.orgId, jobId, idx: 1, payload: { fullName: 'Mid Flight', email: `mid.${u}@example.com` }, status: 'processing', attempts: 1 }),
        rows.create({ organizationId: org.orgId, jobId, idx: 2, payload: { fullName: 'SAVED PERSON', email: savedEmail }, status: 'pending' }),
      ]);
    });
    when('the worker picks up abandoned imports', async () => {
      await h.app.get(ImportJobsService).tick();
    });
    then(/^the import finishes with (\d+) rows processed$/, async (n: string) => {
      const job = await waitDone(org, jobId);
      expect(job.status).toBe('completed');
      expect(job.processedRows).toBe(Number(n));
      expect(job.counts.created).toBe(2);
      expect(job.counts.merged).toBe(1);
    });
    and('the person from the saved row exists only once', async () => {
      const res = (await api().get(`${API}/candidates?q=${encodeURIComponent(savedEmail)}&limit=10`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(res.total).toBe(1);
      expect(await candidateCount(org)).toBe(2);
    });
  });

  test('imports are permission-gated and org-scoped', ({ given, and, then }) => {
    let org: CreatedOrg;
    let jobId: string;
    given('an organization', async () => { org = await newOrg(); });
    and('the owner has started an import', async () => {
      jobId = (await start(org, { rows: [{ fullName: 'Gate Keeper', email: `gate.${uniq()}@example.com` }] }).expect(202)).body.data.id;
    });
    then('an employee without recruitment access cannot start or read imports', async () => {
      const emp = await h.createEmployeeMember(org);
      await start(org, { rows: [{ fullName: 'Nope', email: 'nope@example.com' }] }, emp.token).expect(403);
      await api().get(`${API}/imports`).set(auth(emp.token)).expect(403);
      await api().get(`${API}/imports/${jobId}`).set(auth(emp.token)).expect(403);
    });
    and('the owner of another organization gets 404 on the import', async () => {
      const other = await newOrg();
      await api().get(`${API}/imports/${jobId}`).set(auth(other.ownerToken)).expect(404);
      await api().get(`${API}/imports/${jobId}/rows`).set(auth(other.ownerToken)).expect(404);
      await api().post(`${API}/imports/${jobId}/cancel`).set(auth(other.ownerToken)).expect(404);
      const list = (await api().get(`${API}/imports`).set(auth(other.ownerToken)).expect(200)).body.data;
      expect(list.find((j: any) => j.id === jobId)).toBeUndefined();
    });
    and('a recruitment view-only member can follow progress but not start, cancel or retry', async () => {
      const token = await viewOnlyMember(org);
      await api().get(`${API}/imports/${jobId}`).set(auth(token)).expect(200);
      await api().get(`${API}/imports/${jobId}/rows?filter=all`).set(auth(token)).expect(200);
      await start(org, { rows: [{ fullName: 'Viewer Row', email: 'viewer@example.com' }] }, token).expect(403);
      await api().post(`${API}/imports/${jobId}/cancel`).set(auth(token)).expect(403);
      await api().post(`${API}/imports/${jobId}/retry`).set(auth(token)).expect(403);
      await waitDone(org, jobId);
    });
  });

  test('a file full of wrong data is refused instead of half-imported', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let res: request.Response;
    given('an organization', async () => { org = await newOrg(); });
    when('the owner tries to import a file where most rows have a broken email or no contact details', async () => {
      const u = uniq();
      res = await start(org, {
        rows: [
          { sheet: 'S', rowNumber: 2, fullName: 'Good Person', email: `good.${u}@example.com` },
          { sheet: 'S', rowNumber: 3, fullName: 'Broken Email', email: 'bad@@example' },
          { sheet: 'S', rowNumber: 4, fullName: 'No Contact' },
          { sheet: 'S', rowNumber: 5, fullName: 'Bad Link', resumeUrl: 'C:/resumes/x.pdf' },
        ],
      });
    });
    then('the import is rejected, naming the rows to fix', () => {
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/3 of 4 rows carry wrong or missing data/i);
      expect(res.body.message).toMatch(/row 3: .*not a valid email address/i);
      expect(res.body.message).toMatch(/Fix the file/i);
    });
    and('no candidates were created and no import was started', async () => {
      expect(await candidateCount(org)).toBe(0);
      expect((await api().get(`${API}/imports`).set(auth(org.ownerToken)).expect(200)).body.data).toHaveLength(0);
    });
  });

  test('duplicates can be discarded instead of merged', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let jobId: string;
    let raviId: string;
    const u = uniq();
    given('an organization', async () => { org = await newOrg(); });
    and(/^an existing candidate "(.*)" with email "(.*)" and company "(.*)"$/, async (name: string, email: string, company: string) => {
      raviId = (await api().post(`${API}/candidates`).set(auth(org.ownerToken)).send({ fullName: name, email, currentCompany: company }).expect(201)).body.data.id;
    });
    and(/^an existing candidate "(.*)" with phone "(.*)"$/, async (name: string, phone: string) => {
      await api().post(`${API}/candidates`).set(auth(org.ownerToken)).send({ fullName: name, phone }).expect(201);
    });
    when(/^the owner imports with duplicates discarded: a row matching Ravi by email, a new person twice and a different "(.*)"$/, async (other: string) => {
      const res = await start(org, {
        duplicates: 'skip', skipPossibleDuplicates: true,
        rows: [
          { sheet: 'S', rowNumber: 2, fullName: 'Ravi Menon', email: 'ravi.menon@example.com', currentCompany: 'New Co' },
          { sheet: 'S', rowNumber: 3, fullName: 'Tara Das', email: `tara.${u}@example.com` },
          { sheet: 'S', rowNumber: 4, fullName: 'TARA DAS', email: `tara.${u}@example.com` },
          { sheet: 'S', rowNumber: 5, fullName: other, email: `sunita.other.${u}@example.com` },
        ],
      }).expect(202);
      jobId = res.body.data.id;
    });
    then(/^the import finishes with (\d+) new, (\d+) merged and (\d+) ignored$/, async (n: string, m: string, s: string) => {
      const job = await waitDone(org, jobId);
      expect(job.counts.created).toBe(Number(n));
      expect(job.counts.merged).toBe(Number(m));
      expect(job.counts.skipped).toBe(Number(s));
      expect(await candidateCount(org)).toBe(3);
    });
    and(/^Ravi's profile still says "(.*)"$/, async (company: string) => {
      const c = (await api().get(`${API}/candidates/${raviId}`).set(auth(org.ownerToken)).expect(200)).body.data.candidate;
      expect(c.currentCompany).toBe(company);
    });
    and('each discarded row names the candidate or row it duplicates', async () => {
      const rows = (await api().get(`${API}/imports/${jobId}/rows?filter=skipped`).set(auth(org.ownerToken)).expect(200)).body.data.items;
      const byRow = Object.fromEntries(rows.map((r: any) => [r.rowNumber, r.messages.join(' ')]));
      expect(byRow[2]).toMatch(/Discarded — duplicate of existing “Ravi Menon” \(same email/);
      expect(byRow[4]).toMatch(/Discarded — duplicate of row 3 in this file/);
      expect(byRow[5]).toMatch(/Discarded — possible duplicate of existing “Sunita Rao” \(same name\)/);
    });
  });

  test('finished imports can be dismissed and only failed rows are retried', ({ given, and, when, then }) => {
    let org: CreatedOrg;
    let jobId: string;
    given('an organization', async () => { org = await newOrg(); });
    and('the owner has started an import', async () => {
      jobId = (await start(org, { rows: [{ fullName: 'Done Deal', email: `done.${uniq()}@example.com` }] }).expect(202)).body.data.id;
    });
    when('the import has finished', async () => {
      expect((await waitDone(org, jobId)).status).toBe('completed');
    });
    then('cancelling it is rejected as already finished', async () => {
      await api().post(`${API}/imports/${jobId}/cancel`).set(auth(org.ownerToken)).expect(409);
    });
    and('retrying it is rejected because nothing failed', async () => {
      await api().post(`${API}/imports/${jobId}/retry`).set(auth(org.ownerToken)).expect(400);
    });
    and('dismissing it hides it from the dashboard list', async () => {
      await api().post(`${API}/imports/${jobId}/dismiss`).set(auth(org.ownerToken)).expect(201);
      const list = (await api().get(`${API}/imports`).set(auth(org.ownerToken)).expect(200)).body.data;
      expect(list.find((j: any) => j.id === jobId)).toBeUndefined();
    });
  });
});
