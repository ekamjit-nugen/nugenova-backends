import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { MessagesService } from './messages.service';
import { ConversationsService } from './conversations.service';
import { ConversationEntity } from '../entities/conversation.entity';
import { MessageEntity, Mention } from '../entities/message.entity';
import { NotifierService } from '../../notification/notifier.service';

/**
 * Unit specs for the message-level isolation gate and the send guards. These
 * exercise `conversationForMember` (via sendMessage) with a mocked repository,
 * so no DB is required — the point is to pin that a message send is refused
 * across orgs and for non-participants, and that the send guards fire.
 */
describe('MessagesService (isolation + send guards)', () => {
  let service: MessagesService;
  let messageFindOne: jest.Mock;
  let messageSave: jest.Mock;
  let convFindOne: jest.Mock;
  let notify: jest.Mock;

  const CONV = (over: Partial<ConversationEntity> = {}): ConversationEntity =>
    ({
      id: 'conv1',
      organizationId: 'orgA',
      type: 'group',
      isArchived: false,
      isDeleted: false,
      settings: null,
      participants: [{ userId: 'alice', role: 'member' } as any],
      ...over,
    }) as ConversationEntity;

  const build = async () => {
    messageFindOne = jest.fn().mockResolvedValue(null); // no idempotency dup
    messageSave = jest.fn().mockImplementation((m) => ({ ...m, id: 'msg1' }));
    convFindOne = jest.fn();
    notify = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagesService,
        {
          provide: getRepositoryToken(MessageEntity),
          useValue: {
            findOne: messageFindOne,
            save: messageSave,
            create: (x: any) => x,
          },
        },
        {
          provide: getRepositoryToken(ConversationEntity),
          useValue: { findOne: convFindOne },
        },
        { provide: ConversationsService, useValue: { updateLastMessage: jest.fn() } },
        { provide: NotifierService, useValue: { notify } },
      ],
    }).compile();
    service = moduleRef.get(MessagesService);
  };

  beforeEach(build);

  it('refuses a send when the conversation belongs to another org (404)', async () => {
    convFindOne.mockResolvedValue(CONV({ organizationId: 'orgB' }));
    await expect(
      service.sendMessage('conv1', 'orgA', 'alice', 'hi'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a send from a non-participant (403)', async () => {
    convFindOne.mockResolvedValue(CONV({ participants: [{ userId: 'bob' } as any] }));
    await expect(
      service.sendMessage('conv1', 'orgA', 'alice', 'hi'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an empty text message (400)', async () => {
    convFindOne.mockResolvedValue(CONV());
    await expect(
      service.sendMessage('conv1', 'orgA', 'alice', '   '),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a send to an archived conversation (400)', async () => {
    convFindOne.mockResolvedValue(CONV({ isArchived: true }));
    await expect(
      service.sendMessage('conv1', 'orgA', 'alice', 'hi'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists a valid message and returns it shaped with id and _id', async () => {
    convFindOne.mockResolvedValue(CONV());
    const res: any = await service.sendMessage('conv1', 'orgA', 'alice', 'hello');
    expect(messageSave).toHaveBeenCalledTimes(1);
    expect(res.id).toBe('msg1');
    expect(res._id).toBe('msg1');
    expect(res.content).toBe('hello');
  });

  it('returns the existing message on an idempotency-key hit (no second write)', async () => {
    messageFindOne.mockResolvedValue({ id: 'dup1', content: 'first' });
    const res: any = await service.sendMessage(
      'conv1', 'orgA', 'alice', 'first', 'text', undefined, undefined, undefined, 'key-1',
    );
    expect(res.id).toBe('dup1');
    expect(messageSave).not.toHaveBeenCalled();
  });
});

/**
 * @mention resolution + fail-safe notify. `resolveMentionRecipients` is pure, so
 * it is exercised directly; the fail-safe path is proven by making the mocked
 * NotifierService throw and asserting the send still succeeds.
 */
describe('MessagesService (mentions)', () => {
  let service: MessagesService;
  let messageSave: jest.Mock;
  let convFindOne: jest.Mock;
  let notify: jest.Mock;

  const CONV = (participantIds: string[], over: Partial<ConversationEntity> = {}): ConversationEntity =>
    ({
      id: 'conv1',
      organizationId: 'orgA',
      type: 'group',
      name: 'Project X',
      isArchived: false,
      isDeleted: false,
      settings: null,
      participants: participantIds.map((userId) => ({ userId, role: 'member' })) as any,
      ...over,
    }) as ConversationEntity;

  const M = (type: 'user' | 'here' | 'all', targetId: string): Mention =>
    ({ type, targetId, displayName: null, offset: 0, length: 0 });

  beforeEach(async () => {
    messageSave = jest.fn().mockImplementation((m) => ({ ...m, id: 'msg1' }));
    convFindOne = jest.fn();
    notify = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagesService,
        {
          provide: getRepositoryToken(MessageEntity),
          useValue: { findOne: jest.fn().mockResolvedValue(null), save: messageSave, create: (x: any) => x },
        },
        { provide: getRepositoryToken(ConversationEntity), useValue: { findOne: convFindOne } },
        { provide: ConversationsService, useValue: { updateLastMessage: jest.fn() } },
        { provide: NotifierService, useValue: { notify } },
      ],
    }).compile();
    service = moduleRef.get(MessagesService);
  });

  describe('resolveMentionRecipients', () => {
    const conv = CONV(['alice', 'bob', 'carol']);

    it('user → the mentioned participant only', () => {
      expect(service.resolveMentionRecipients(conv, [M('user', 'bob')], 'alice')).toEqual(['bob']);
    });

    it('user → ignores a non-participant target', () => {
      expect(service.resolveMentionRecipients(conv, [M('user', 'zoe')], 'alice')).toEqual([]);
    });

    it('here → every participant except the sender', () => {
      const out = service.resolveMentionRecipients(conv, [M('here', '')], 'alice');
      expect(out.sort()).toEqual(['bob', 'carol']);
    });

    it('all → every participant except the sender', () => {
      const out = service.resolveMentionRecipients(conv, [M('all', 'conv1')], 'alice');
      expect(out.sort()).toEqual(['bob', 'carol']);
    });

    it('de-dupes across overlapping mentions and always excludes the sender', () => {
      const out = service.resolveMentionRecipients(
        conv,
        [M('all', ''), M('user', 'bob'), M('user', 'alice')],
        'alice',
      );
      expect(out.sort()).toEqual(['bob', 'carol']);
    });

    it('empty / undefined mentions → no recipients', () => {
      expect(service.resolveMentionRecipients(conv, [], 'alice')).toEqual([]);
      expect(service.resolveMentionRecipients(conv, undefined, 'alice')).toEqual([]);
    });
  });

  it('notifies each resolved recipient on send with a chat_mention', async () => {
    convFindOne.mockResolvedValue(CONV(['alice', 'bob', 'carol']));
    await service.sendMessage(
      'conv1', 'orgA', 'alice', 'hey @bob', 'text',
      undefined, 'Alice A', undefined, undefined, [{ type: 'user', targetId: 'bob' }],
    );
    expect(notify).toHaveBeenCalledTimes(1);
    const arg = notify.mock.calls[0][0];
    expect(arg).toMatchObject({ userId: 'bob', actorId: 'alice', type: 'chat_mention' });
    expect(arg.data.conversationId).toBe('conv1');
  });

  it('persists the mentions on the stored message', async () => {
    convFindOne.mockResolvedValue(CONV(['alice', 'bob']));
    await service.sendMessage(
      'conv1', 'orgA', 'alice', 'hey @bob', 'text',
      undefined, undefined, undefined, undefined, [{ type: 'user', targetId: 'bob' }],
    );
    const saved = messageSave.mock.calls[0][0];
    expect(saved.mentions).toEqual([
      { type: 'user', targetId: 'bob', displayName: null, offset: 0, length: 0 },
    ]);
  });

  it('is fail-safe: a throwing notifier still lets the send succeed', async () => {
    convFindOne.mockResolvedValue(CONV(['alice', 'bob']));
    notify.mockRejectedValue(new Error('notifier down'));
    const res: any = await service.sendMessage(
      'conv1', 'orgA', 'alice', 'hey @bob', 'text',
      undefined, undefined, undefined, undefined, [{ type: 'user', targetId: 'bob' }],
    );
    expect(res.id).toBe('msg1');
    expect(messageSave).toHaveBeenCalledTimes(1);
  });
});
