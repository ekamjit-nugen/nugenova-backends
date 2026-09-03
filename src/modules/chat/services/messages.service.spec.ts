import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { MessagesService } from './messages.service';
import { ConversationsService } from './conversations.service';
import { ConversationEntity } from '../entities/conversation.entity';
import { MessageEntity } from '../entities/message.entity';

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
