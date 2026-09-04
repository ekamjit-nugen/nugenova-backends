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
import { ChatBookmarkEntity } from '../entities/chat-bookmark.entity';
import { NotificationEntity } from '../../notification/entities/notification.entity';

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
  let bookmarks: Repository<ChatBookmarkEntity>;
  let notifs: Repository<NotificationEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    conversations = h.app.get(getRepositoryToken(ConversationEntity));
    messages = h.app.get(getRepositoryToken(MessageEntity));
    bookmarks = h.app.get(getRepositoryToken(ChatBookmarkEntity));
    notifs = h.app.get(getRepositoryToken(NotificationEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await notifs.delete({ organizationId: In(ids) }).catch(() => undefined);
      await bookmarks.delete({ organizationId: In(ids) }).catch(() => undefined);
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

  const createGroup = (actor: Member, name: string, memberIds: string[]) =>
    h.api().post(`${API}/chat/conversations/group`).set(auth(actor.token)).send({ name, memberIds });

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

  test('a pinned message shows up in the conversation\'s pinned list', ({ given, when, then }) => {
    let a: Member;
    let b: Member;
    let convId: string;
    let msgId: string;

    given('an organization with two members and a direct conversation between them', async () => {
      ({ a, b } = await orgWithTwo());
      const res = await openDirect(a, b.userId).expect(201);
      convId = res.body.data.id;
    });
    when('the first member sends "Pin me" and pins it', async () => {
      const sent = await send(a, convId, 'Pin me').expect(201);
      msgId = sent.body.data.id;
      await h.api().put(`${API}/chat/messages/${msgId}/pin`).set(auth(a.token)).expect(200);
    });
    then('the conversation\'s pinned list contains "Pin me"', async () => {
      const res = await h
        .api()
        .get(`${API}/chat/conversations/${convId}/pinned`)
        .set(auth(a.token))
        .expect(200);
      const pinned = res.body.data as any[];
      expect(pinned.map((m) => m.id)).toContain(msgId);
      expect(pinned.find((m) => m.id === msgId)?.isPinned).toBe(true);
    });
  });

  test('forwarding a message copies it into another conversation the user is in', ({ given, and, when, then }) => {
    let a: Member;
    let b: Member;
    let directId: string;
    let groupId: string;
    let originalId: string;
    let forwardRes: request.Response;

    given('an organization with two members and a direct conversation between them', async () => {
      ({ a, b } = await orgWithTwo());
      const res = await openDirect(a, b.userId).expect(201);
      directId = res.body.data.id;
      const sent = await send(a, directId, 'Forward me please').expect(201);
      originalId = sent.body.data.id;
    });
    and('the first member is also in a group conversation', async () => {
      const res = await createGroup(a, 'Forward Target', [b.userId]).expect(201);
      groupId = res.body.data.id;
    });
    when('the first member forwards a message from the direct into the group', async () => {
      forwardRes = await h
        .api()
        .post(`${API}/chat/messages/${originalId}/forward`)
        .set(auth(a.token))
        .send({ conversationIds: [groupId] })
        .expect(201);
    });
    then('the group has a forwarded copy carrying the original\'s forwardedFrom', async () => {
      const created = forwardRes.body.data as any[];
      expect(created).toHaveLength(1);
      expect(created[0].type).toBe('forwarded');

      const res = await listMessages(a, groupId).expect(200);
      const rows = res.body.data as any[];
      const copy = rows.find((m) => m.type === 'forwarded');
      expect(copy).toBeDefined();
      expect(copy.content).toContain('Forward me please');
      expect(copy.forwardedFrom).toMatchObject({
        messageId: originalId,
        conversationId: directId,
        senderId: a.userId,
      });
    });
  });

  test('a bookmarked message appears in the owner\'s bookmarks and not another user\'s', ({ given, when, then, and }) => {
    let a: Member;
    let b: Member;
    let convId: string;
    let msgId: string;

    given('an organization with two members and a direct conversation between them', async () => {
      ({ a, b } = await orgWithTwo());
      const res = await openDirect(a, b.userId).expect(201);
      convId = res.body.data.id;
    });
    when('the first member sends "Save me" and bookmarks it', async () => {
      const sent = await send(a, convId, 'Save me').expect(201);
      msgId = sent.body.data.id;
      await h.api().put(`${API}/chat/messages/${msgId}/bookmark`).set(auth(a.token)).expect(200);
      // Idempotent: a second save must not create a duplicate.
      await h.api().put(`${API}/chat/messages/${msgId}/bookmark`).set(auth(a.token)).expect(200);
    });
    then('the first member\'s bookmarks include "Save me"', async () => {
      const res = await h.api().get(`${API}/chat/bookmarks`).set(auth(a.token)).expect(200);
      const rows = res.body.data as any[];
      const mine = rows.filter((r) => r.messageId === msgId);
      expect(mine).toHaveLength(1); // idempotent — exactly one
      expect(mine[0].message?.content).toContain('Save me');
    });
    and('the second member\'s bookmarks do not include it', async () => {
      const res = await h.api().get(`${API}/chat/bookmarks`).set(auth(b.token)).expect(200);
      const ids = (res.body.data as any[]).map((r) => r.messageId);
      expect(ids).not.toContain(msgId);
    });
  });

  test('a member uploads a file, sends it, and participants can fetch it', ({ given, when, then, and }) => {
    let a: Member;
    let b: Member;
    let convId: string;
    let fileId: string;
    let msg: request.Response;
    const bytes = Buffer.from('the quick brown fox PNG bytes');

    given('an organization with two members and a direct conversation between them', async () => {
      ({ a, b } = await orgWithTwo());
      const res = await openDirect(a, b.userId).expect(201);
      convId = res.body.data.id;
    });
    when('the first member uploads a file and sends it as a message', async () => {
      const up = await h
        .api()
        .post(`${API}/chat/upload`)
        .set(auth(a.token))
        .attach('file', bytes, 'note.png')
        .expect(201);
      fileId = up.body.data.fileId;
      expect(fileId).toBeDefined();
      expect(up.body.data).toMatchObject({
        fileName: 'note.png',
        fileSize: bytes.length,
        fileMimeType: 'image/png',
      });
      // Real contract: the client echoes back fileId + metadata only — NO fileUrl
      // (URLs are resolved on demand via GET /chat/files/:fileId).
      msg = await h
        .api()
        .post(`${API}/chat/conversations/${convId}/messages`)
        .set(auth(a.token))
        .send({
          type: 'image',
          fileId,
          fileName: up.body.data.fileName,
          fileSize: up.body.data.fileSize,
          fileMimeType: up.body.data.fileMimeType,
        })
        .expect(201);
    });
    then('the message carries the attachment fields', () => {
      expect(msg.body.data).toMatchObject({
        type: 'image',
        fileId,
        fileName: 'note.png',
        fileSize: bytes.length,
        fileMimeType: 'image/png',
      });
    });
    and('the first member can fetch the file', async () => {
      // Bytes are streamed through the authenticated endpoint itself — the SAME
      // 200 for both the S3 and bytea drivers (S3 is fetched server-side; no
      // presigned URL / redirect ever leaves the server).
      const res = await h
        .api()
        .get(`${API}/chat/files/${fileId}`)
        .set(auth(a.token))
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['content-disposition']).toContain('inline');
      expect(res.headers['cache-control']).toContain('no-store');
    });
    and('the second member can fetch the file', async () => {
      const res = await h.api().get(`${API}/chat/files/${fileId}`).set(auth(b.token));
      expect(res.status).toBe(200);
    });
    and('an unauthenticated fetch is rejected', async () => {
      // No bearer token → the guard 401s before any access check; opening the raw
      // URL in a new tab can never reach the bytes.
      const res = await h.api().get(`${API}/chat/files/${fileId}`);
      expect(res.status).toBe(401);
    });
  });

  test('a non-participant cannot fetch a conversation\'s file', ({ given, and, when, then }) => {
    let a: Member;
    let b: Member;
    let c: Member;
    let o: CreatedOrg;
    let convId: string;
    let fileId: string;
    const bytes = Buffer.from('secret attachment bytes');

    given('an organization with two members and a direct conversation between them', async () => {
      ({ o, a, b } = await orgWithTwo());
      const res = await openDirect(a, b.userId).expect(201);
      convId = res.body.data.id;
    });
    and('a third member of the same organization', async () => {
      c = await h.createEmployeeMember(o);
    });
    when('the first member uploads a file and sends it as a message', async () => {
      const up = await h
        .api()
        .post(`${API}/chat/upload`)
        .set(auth(a.token))
        .attach('file', bytes, 'secret.png')
        .expect(201);
      fileId = up.body.data.fileId;
      await h
        .api()
        .post(`${API}/chat/conversations/${convId}/messages`)
        .set(auth(a.token))
        .send({ type: 'image', fileId, fileName: 'secret.png' })
        .expect(201);
    });
    then('the third member is refused the file as not found', async () => {
      const res = await h.api().get(`${API}/chat/files/${fileId}`).set(auth(c.token));
      expect(res.status).toBe(404);
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

  test('mentioning a participant persists the mention and notifies them', ({ given, when, then, and }) => {
    let a: Member; // sender
    let b: Member; // participant, mentioned
    let c: Member; // org member but NOT a participant, also mentioned
    let convId: string;
    let msgId: string;

    given('an organization with three members and a group conversation between two of them', async () => {
      const o = await h.createOrg();
      orgIds.add(o.orgId);
      a = await h.createEmployeeMember(o);
      b = await h.createEmployeeMember(o);
      c = await h.createEmployeeMember(o);
      const res = await h
        .api()
        .post(`${API}/chat/conversations/group`)
        .set(auth(a.token))
        .send({ name: 'Mentions', memberIds: [b.userId] })
        .expect(201);
      convId = res.body.data.id;
    });

    when('the first member sends a message mentioning the second and the non-participant third', async () => {
      const res = await h
        .api()
        .post(`${API}/chat/conversations/${convId}/messages`)
        .set(auth(a.token))
        .send({
          content: 'hey team',
          mentions: [
            { type: 'user', targetId: b.userId },
            { type: 'user', targetId: c.userId },
          ],
        })
        .expect(201);
      msgId = res.body.data.id;
      expect(msgId).toBeDefined();
    });

    then('the stored message persists both mentions', async () => {
      const stored = await messages.findOne({ where: { id: msgId } });
      expect(stored?.mentions?.map((m) => m.targetId).sort()).toEqual(
        [b.userId, c.userId].sort(),
      );
    });

    and('the mentioned participant receives a chat mention notification', async () => {
      const rows = await notifs.find({ where: { userId: b.userId, type: 'chat_mention' } });
      expect(rows.length).toBe(1);
      expect((rows[0].data as any).conversationId).toBe(convId);
    });

    and('the non-participant does not receive a notification', async () => {
      const rows = await notifs.find({ where: { userId: c.userId, type: 'chat_mention' } });
      expect(rows.length).toBe(0);
    });
  });
});
