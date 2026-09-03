import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  CreatedOrg,
  OrgTestHarness,
} from '../../organization/features/support/org-harness';
import { ConversationEntity } from '../entities/conversation.entity';
import { MessageEntity } from '../entities/message.entity';

const feature = loadFeature('./chat.feature', { loadRelativePath: true });
const API = '/api/v1';

interface Member {
  email: string;
  userId: string;
  token: string;
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let conversations: Repository<ConversationEntity>;
  let messages: Repository<MessageEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    conversations = h.app.get(getRepositoryToken(ConversationEntity));
    messages = h.app.get(getRepositoryToken(MessageEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await messages.delete({ organizationId: In(ids) }).catch(() => undefined);
      await conversations.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const openDirect = (actor: Member, targetUserId: string) =>
    h.api().post(`${API}/chat/conversations/direct`).set(auth(actor.token)).send({ targetUserId });

  const send = (actor: Member, convId: string, content: string) =>
    h.api().post(`${API}/chat/conversations/${convId}/messages`).set(auth(actor.token)).send({ content });

  const listMessages = (actor: Member, convId: string) =>
    h.api().get(`${API}/chat/conversations/${convId}/messages`).set(auth(actor.token));

  const orgWithTwo = async (): Promise<{ o: CreatedOrg; a: Member; b: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const a = await h.createEmployeeMember(o);
    const b = await h.createEmployeeMember(o);
    return { o, a, b };
  };

  const contents = (res: request.Response): string[] =>
    (res.body.data as any[]).map((m) => m.content);

  // ── scenarios ──────────────────────────────────────────────────────────────

  test('a member starts a direct conversation and sends a message', ({ given, when, and, then }) => {
    let a: Member;
    let b: Member;
    let convId: string;
    let sendRes: request.Response;

    given('an organization with two members', async () => {
      ({ a, b } = await orgWithTwo());
    });
    when('the first member opens a direct conversation with the second', async () => {
      const res = await openDirect(a, b.userId).expect(201);
      convId = res.body.data.id;
      expect(convId).toBeDefined();
    });
    and('the first member sends "Hello there" to it', async () => {
      sendRes = await send(a, convId, 'Hello there').expect(201);
    });
    then('the message is stored and returned with an id', () => {
      expect(sendRes.body.data.id).toBeDefined();
      expect(sendRes.body.data.content).toContain('Hello there');
    });
    and('listing the conversation\'s messages returns "Hello there"', async () => {
      const res = await listMessages(a, convId).expect(200);
      expect(contents(res).join(' ')).toContain('Hello there');
    });
  });

  test('the other participant can read the messages', ({ given, when, then }) => {
    let a: Member;
    let b: Member;
    let convId: string;

    given('an organization with two members and a direct conversation between them', async () => {
      ({ a, b } = await orgWithTwo());
      const res = await openDirect(a, b.userId).expect(201);
      convId = res.body.data.id;
    });
    when('the first member sends "Standup at 10" to it', async () => {
      await send(a, convId, 'Standup at 10').expect(201);
    });
    then('the second member can list the conversation and see "Standup at 10"', async () => {
      const res = await listMessages(b, convId).expect(200);
      expect(contents(res).join(' ')).toContain('Standup at 10');
    });
  });

  test('an empty text message is rejected', ({ given, when, then }) => {
    let a: Member;
    let b: Member;
    let convId: string;
    let res: request.Response;

    given('an organization with two members and a direct conversation between them', async () => {
      ({ a, b } = await orgWithTwo());
      const r = await openDirect(a, b.userId).expect(201);
      convId = r.body.data.id;
    });
    when('the first member sends a blank message', async () => {
      res = await send(a, convId, '   ');
    });
    then('the send is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a group conversation lists for all its members', ({ given, when, then }) => {
    let a: Member;
    let b: Member;
    let convId: string;

    given('an organization with two members', async () => {
      ({ a, b } = await orgWithTwo());
    });
    when('the first member creates a group with the second', async () => {
      const res = await h
        .api()
        .post(`${API}/chat/conversations/group`)
        .set(auth(a.token))
        .send({ name: 'Project X', memberIds: [b.userId] })
        .expect(201);
      convId = res.body.data.id;
    });
    then('both members see the group in their conversation list', async () => {
      for (const m of [a, b]) {
        const res = await h.api().get(`${API}/chat/conversations`).set(auth(m.token)).expect(200);
        const ids = (res.body.data as any[]).map((c) => c.id);
        expect(ids).toContain(convId);
      }
    });
  });

  test('a member cannot read a conversation they are not part of', ({ given, and, when, then }) => {
    let a: Member;
    let b: Member;
    let c: Member;
    let o: CreatedOrg;
    let convId: string;

    given('an organization with two members and a direct conversation between them', async () => {
      ({ o, a, b } = await orgWithTwo());
      const res = await openDirect(a, b.userId).expect(201);
      convId = res.body.data.id;
    });
    and('a third member of the same organization', async () => {
      c = await h.createEmployeeMember(o);
    });
    when('the third member tries to read that conversation', async () => {
      // stored on the outer scope via then
    });
    then('the read is rejected as forbidden', async () => {
      const res = await h.api().get(`${API}/chat/conversations/${convId}`).set(auth(c.token));
      expect(res.status).toBe(403);
    });
  });

  test('one organization cannot see another organization\'s messages', ({ given, when, and, then }) => {
    let a1: Member; // org 1 member
    let conv2Id: string; // org 2's conversation

    given('two separate organizations each with a conversation and a message', async () => {
      const o1 = await orgWithTwo();
      a1 = o1.a;
      const c1 = await openDirect(o1.a, o1.b.userId).expect(201);
      await send(o1.a, c1.body.data.id, 'org1 secret').expect(201);

      const o2 = await orgWithTwo();
      const c2 = await openDirect(o2.a, o2.b.userId).expect(201);
      conv2Id = c2.body.data.id;
      await send(o2.a, conv2Id, 'org2 secret').expect(201);
    });
    when('a member of the first organization tries to read the second\'s conversation', async () => {
      // asserted in the two then/and steps below
    });
    then('the read is rejected as not found', async () => {
      const res = await h.api().get(`${API}/chat/conversations/${conv2Id}`).set(auth(a1.token));
      expect(res.status).toBe(404);
    });
    and('the first organization\'s conversation list does not include the second\'s', async () => {
      const res = await h.api().get(`${API}/chat/conversations`).set(auth(a1.token)).expect(200);
      const ids = (res.body.data as any[]).map((c) => c.id);
      expect(ids).not.toContain(conv2Id);
    });
  });
});
