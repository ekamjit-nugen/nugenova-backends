import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ConversationsService } from './conversations.service';
import { ConversationEntity } from '../entities/conversation.entity';
import { UserEntity } from '../../auth/entities/user.entity';

/**
 * Unit specs for the conversation-level isolation gate (`loadForMember`, via
 * getConversation) plus the direct-conversation self-guard. Repositories are
 * mocked, so no DB is required.
 */
describe('ConversationsService (isolation)', () => {
  let service: ConversationsService;
  let convFindOne: jest.Mock;
  let userFind: jest.Mock;

  const CONV = (over: Partial<ConversationEntity> = {}): ConversationEntity =>
    ({
      id: 'conv1',
      organizationId: 'orgA',
      type: 'group',
      name: 'General',
      isDeleted: false,
      participants: [{ userId: 'alice', role: 'member' } as any],
      participantIds: ['alice'],
      ...over,
    }) as ConversationEntity;

  const build = async () => {
    convFindOne = jest.fn();
    userFind = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConversationsService,
        {
          provide: getRepositoryToken(ConversationEntity),
          useValue: { findOne: convFindOne },
        },
        { provide: getRepositoryToken(UserEntity), useValue: { find: userFind } },
      ],
    }).compile();
    service = moduleRef.get(ConversationsService);
  };

  beforeEach(build);

  it('hides another org\'s conversation as not-found', async () => {
    convFindOne.mockResolvedValue(CONV({ organizationId: 'orgB' }));
    await expect(
      service.getConversation('conv1', 'orgA', 'alice'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forbids a same-org non-participant', async () => {
    convFindOne.mockResolvedValue(CONV({ participants: [{ userId: 'bob' } as any] }));
    await expect(
      service.getConversation('conv1', 'orgA', 'alice'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the conversation for a same-org participant, shaped with id/_id', async () => {
    convFindOne.mockResolvedValue(CONV());
    const res: any = await service.getConversation('conv1', 'orgA', 'alice');
    expect(res.id).toBe('conv1');
    expect(res._id).toBe('conv1');
    expect(res.name).toBe('General');
  });

  it('rejects a direct conversation with yourself', async () => {
    await expect(
      service.createDirect('alice', 'alice', 'orgA'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
