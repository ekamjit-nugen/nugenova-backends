import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness } from '../../organization/features/support/org-harness';
import { AiUsageEventEntity } from '../entities/ai-usage-event.entity';
import { AiUsageCounterEntity } from '../entities/ai-usage-counter.entity';
import { LLM_PROVIDER, LlmProvider } from '../providers/llm-provider';
import { AI_POLICY, AiPolicy } from '../policy/ai-policy';

const feature = loadFeature('./ai.feature', { loadRelativePath: true });
const API = '/api/v1';

interface Member {
  email: string;
  userId: string;
  token: string;
}

/**
 * e2e for the AI runtime. The provider + policy singletons wired in AppModule are
 * SPIED, not called: `complete` returns a canned completion so no live LLM call
 * is ever made, and the deny scenario forces the policy to refuse. Everything
 * else (auth, org scoping, metering, DB) runs for real against the shared
 * Postgres. Typecheck only — this suite is NOT executed in the port.
 */
defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let events: Repository<AiUsageEventEntity>;
  let counters: Repository<AiUsageCounterEntity>;
  let provider: LlmProvider;
  let policy: AiPolicy;
  let completeSpy: jest.SpyInstance;
  let policySpy: jest.SpyInstance;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    events = h.app.get(getRepositoryToken(AiUsageEventEntity));
    counters = h.app.get(getRepositoryToken(AiUsageCounterEntity));
    provider = h.app.get<LlmProvider>(LLM_PROVIDER);
    policy = h.app.get<AiPolicy>(AI_POLICY);
  });

  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await events.delete({ organizationId: In(ids) }).catch(() => undefined);
      await counters.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  beforeEach(() => {
    completeSpy = jest.spyOn(provider, 'complete').mockResolvedValue({
      text: 'Hi there!',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    });
    policySpy = jest.spyOn(policy, 'check').mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    completeSpy.mockRestore();
    policySpy.mockRestore();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const complete = (actor: Member, messages: Array<{ role: string; content: string }>) =>
    h.api().post(`${API}/ai/complete`).set(auth(actor.token)).send({ messages });

  const readUsage = (actor: Member) => h.api().get(`${API}/ai/usage`).set(auth(actor.token));

  const orgWithMember = async (): Promise<{ o: CreatedOrg; m: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const m = await h.createEmployeeMember(o);
    return { o, m };
  };

  // ── completion runs, is metered, returns tokens ──
  test('a completion runs through the provider, is metered, and returns tokens', ({ given, when, then, and }) => {
    let member: Member;
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization with a member', async () => {
      const x = await orgWithMember();
      org = x.o;
      member = x.m;
    });
    when('the member requests a completion for "Say hi"', async () => {
      res = await complete(member, [{ role: 'user', content: 'Say hi' }]);
    });
    then('the response carries the generated text and token counts', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.text).toBe('Hi there!');
      expect(res.body.data.usage.totalTokens).toBe(16);
      expect(completeSpy).toHaveBeenCalled();
    });
    and('the org\'s AI usage balance reflects the call', async () => {
      const balance = await readUsage(member);
      expect(balance.body.data.balance.totalTokens).toBeGreaterThanOrEqual(16);
      expect(balance.body.data.balance.requestCount).toBeGreaterThanOrEqual(1);
      expect(balance.body.data.balance.organizationId).toBe(org.orgId);
    });
  });

  test('an unauthenticated completion is rejected', ({ given, when, then }) => {
    given('an organization with a member', async () => {
      await orgWithMember();
    });
    let res: request.Response;
    when('an unauthenticated client requests a completion', async () => {
      res = await h.api().post(`${API}/ai/complete`).send({ messages: [{ role: 'user', content: 'hi' }] });
    });
    then('the request is rejected as unauthorized', () => {
      expect(res.status).toBe(401);
    });
  });

  test('an empty messages array is rejected as a bad request', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with a member', async () => {
      member = (await orgWithMember()).m;
    });
    when('the member requests a completion with no messages', async () => {
      res = await complete(member, []);
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('the usage endpoint returns the caller\'s org balance and series', ({ given, when, then }) => {
    let member: Member;
    let org: CreatedOrg;
    let res: request.Response;
    given('an organization with a member who has run a completion', async () => {
      const x = await orgWithMember();
      org = x.o;
      member = x.m;
      await complete(member, [{ role: 'user', content: 'hi' }]);
    });
    when('the member reads the AI usage balance', async () => {
      res = await readUsage(member);
    });
    then('the balance is for their own organization and current period', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.balance.organizationId).toBe(org.orgId);
      expect(res.body.data.balance.period).toMatch(/^\d{4}-\d{2}$/);
      expect(Array.isArray(res.body.data.series)).toBe(true);
    });
  });

  test('one organization cannot see another organization\'s AI usage', ({ given, when, then }) => {
    let first: Member;
    let firstOrg: CreatedOrg;
    let res: request.Response;
    given('two organizations that have each run a completion', async () => {
      const a = await orgWithMember();
      firstOrg = a.o;
      first = a.m;
      const b = await orgWithMember();
      await complete(first, [{ role: 'user', content: 'a' }]);
      await complete(b.m, [{ role: 'user', content: 'b' }]);
    });
    when('a member of the first organization reads the AI usage balance', async () => {
      res = await readUsage(first);
    });
    then('only the first organization\'s usage is returned', () => {
      expect(res.body.data.balance.organizationId).toBe(firstOrg.orgId);
      for (const row of res.body.data.series) {
        expect(row.organizationId).toBe(firstOrg.orgId);
      }
    });
  });

  test('the tier/consent policy can deny a call before it runs', ({ given, when, then, and }) => {
    let member: Member;
    let org: CreatedOrg;
    let res: request.Response;
    given('an organization whose AI policy denies calls', async () => {
      const x = await orgWithMember();
      org = x.o;
      member = x.m;
      policySpy.mockResolvedValue({ allowed: false, reason: 'over tier ceiling', code: 'tier_ceiling' });
    });
    when('the member requests a completion', async () => {
      res = await complete(member, [{ role: 'user', content: 'hi' }]);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
      expect(completeSpy).not.toHaveBeenCalled();
    });
    and('no usage is recorded for the denied call', async () => {
      const rows = await events.find({ where: { organizationId: org.orgId } });
      expect(rows.length).toBe(0);
    });
  });
});
