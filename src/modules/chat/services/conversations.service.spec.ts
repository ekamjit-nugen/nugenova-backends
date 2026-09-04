import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ConversationsService } from './conversations.service';
import { ConversationEntity } from '../entities/conversation.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

/**
 * Unit specs for the conversation-level isolation gate (`loadForMember`, via
 * getConversation) plus the direct-conversation self-guard. Repositories are
 * mocked, so no DB is required.
 */
describe('ConversationsService (isolation)', () => {
  let service: ConversationsService;
  let convFindOne: jest.Mock;
  let userFind: jest.Mock;
  let membershipFind: jest.Mock;

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
    membershipFind = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConversationsService,
        {
          provide: getRepositoryToken(ConversationEntity),
          useValue: { findOne: convFindOne },
        },
        { provide: getRepositoryToken(UserEntity), useValue: { find: userFind } },
        {
          provide: getRepositoryToken(OrgMembershipEntity),
          useValue: { find: membershipFind },
        },
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

  describe('directory (messageable members)', () => {
    it('lists active org members with an account, excluding the caller + accountless rows', async () => {
      membershipFind.mockResolvedValue([
        { id: 'm1', userId: 'alice', organizationId: 'orgA', status: 'active', role: 'owner', email: 'a@x' },
        { id: 'm2', userId: 'bob', organizationId: 'orgA', status: 'active', role: 'employee', email: 'b@x' },
        { id: 'm3', userId: null, organizationId: 'orgA', status: 'active', role: 'employee', email: 'c@x' },
      ]);
      userFind.mockResolvedValue([{ id: 'bob', firstName: 'Bob', lastName: 'Ray' }]);

      const res = await service.directory('orgA', 'alice');

      // alice (self) and the account-less row are excluded; bob remains.
      expect(res.map((m) => m.userId)).toEqual(['bob']);
      expect(res[0]).toMatchObject({
        membershipId: 'm2',
        userId: 'bob',
        firstName: 'Bob',
        lastName: 'Ray',
        role: 'employee',
      });
      // Always scoped to the caller's org + active members only.
      expect(membershipFind).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'orgA', status: 'active' }),
        }),
      );
    });
  });
});
