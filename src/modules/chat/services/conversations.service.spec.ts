import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ConversationsService } from './conversations.service';
import { ChatSettingsService } from './chat-settings.service';
import { NotifierService } from '../../notification/notifier.service';
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
  let convSave: jest.Mock;
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
    convSave = jest.fn().mockImplementation(async (c) => c);
    userFind = jest.fn().mockResolvedValue([]);
    membershipFind = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConversationsService,
        {
          provide: getRepositoryToken(ConversationEntity),
          useValue: { findOne: convFindOne, save: convSave },
        },
        { provide: getRepositoryToken(UserEntity), useValue: { find: userFind } },
        {
          provide: getRepositoryToken(OrgMembershipEntity),
          useValue: { find: membershipFind },
        },
        {
          provide: ChatSettingsService,
          useValue: {
            load: jest.fn().mockResolvedValue({
              shareHistoryDefault: true,
              whoCanManageGroups: 'creator_and_admins',
            }),
            canManageGroup: () => true,
            isAdmin: () => false,
          },
        },
        { provide: NotifierService, useValue: { notify: jest.fn().mockResolvedValue(undefined) } },
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

  describe('group management (add/remove/rename/picture + share-history)', () => {
    const GROUP = (over: Partial<ConversationEntity> = {}) =>
      CONV({
        id: 'g1',
        type: 'group',
        createdBy: 'alice',
        participants: [{ userId: 'alice', role: 'owner' } as any],
        participantIds: ['alice'],
        ...over,
      });

    it('addParticipants WITHOUT sharing history sets a historyFrom cutoff on the new member', async () => {
      convFindOne.mockResolvedValue(GROUP());
      await service.addParticipants('g1', 'orgA', ['bob'], 'alice', { shareHistory: false });
      const bob = convSave.mock.calls[0][0].participants.find((p: any) => p.userId === 'bob');
      expect(bob.historyFrom).toBeTruthy();
    });

    it('addParticipants sharing history leaves historyFrom null (full history)', async () => {
      convFindOne.mockResolvedValue(GROUP());
      await service.addParticipants('g1', 'orgA', ['bob'], 'alice', { shareHistory: true });
      const bob = convSave.mock.calls[0][0].participants.find((p: any) => p.userId === 'bob');
      expect(bob.historyFrom).toBeNull();
    });

    it('addParticipants is forbidden when the manage policy denies the caller', async () => {
      convFindOne.mockResolvedValue(GROUP());
      (service as any).chatSettings.canManageGroup = () => false;
      await expect(
        service.addParticipants('g1', 'orgA', ['bob'], 'alice', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('updateGroup renames and sets the picture', async () => {
      convFindOne.mockResolvedValue(GROUP());
      await service.updateGroup('g1', 'orgA', 'alice', 'owner', {
        name: 'Renamed',
        avatar: 'data:image/png;base64,x',
      });
      const saved = convSave.mock.calls[0][0];
      expect(saved.name).toBe('Renamed');
      expect(saved.avatar).toBe('data:image/png;base64,x');
    });

    it('removeParticipant drops the member', async () => {
      convFindOne.mockResolvedValue(
        GROUP({
          participants: [
            { userId: 'alice', role: 'owner' } as any,
            { userId: 'bob', role: 'member' } as any,
          ],
          participantIds: ['alice', 'bob'],
        }),
      );
      await service.removeParticipant('g1', 'orgA', 'bob', 'alice', 'owner');
      const saved = convSave.mock.calls[0][0];
      expect(saved.participants.map((p: any) => p.userId)).toEqual(['alice']);
    });
  });
});
