import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ChatRetentionService } from './chat-retention.service';
import { MessageEntity } from '../entities/message.entity';
import { OrgChatSettingEntity } from '../entities/org-chat-setting.entity';

/**
 * Unit specs for the nightly retention sweep. Repos are mocked; `now` is
 * injected so the cutoff is deterministic. Pins: orgs with retentionDays=0 are
 * skipped, a positive window soft-deletes older messages at the right cutoff,
 * and the sweep never throws.
 */
describe('ChatRetentionService', () => {
  let service: ChatRetentionService;
  let messagesUpdate: jest.Mock;
  let settingsFind: jest.Mock;

  const NOW = new Date('2026-09-10T03:00:00.000Z');

  beforeEach(async () => {
    messagesUpdate = jest.fn().mockResolvedValue({ affected: 3 });
    settingsFind = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatRetentionService,
        { provide: getRepositoryToken(MessageEntity), useValue: { update: messagesUpdate } },
        { provide: getRepositoryToken(OrgChatSettingEntity), useValue: { find: settingsFind } },
      ],
    }).compile();
    service = moduleRef.get(ChatRetentionService);
  });

  it('skips orgs with retention disabled (0)', async () => {
    settingsFind.mockResolvedValue([
      { organizationId: 'orgA', settings: { retentionDays: 0 } },
      { organizationId: 'orgB', settings: {} },
    ]);
    await service.sweep(NOW);
    expect(messagesUpdate).not.toHaveBeenCalled();
  });

  it('soft-deletes messages older than the window at the right cutoff', async () => {
    settingsFind.mockResolvedValue([{ organizationId: 'orgA', settings: { retentionDays: 7 } }]);
    await service.sweep(NOW);

    expect(messagesUpdate).toHaveBeenCalledTimes(1);
    const [criteria, patch] = messagesUpdate.mock.calls[0];
    expect(criteria.organizationId).toBe('orgA');
    expect(criteria.isDeleted).toBe(false);
    // LessThan(cutoff) where cutoff = now - 7 days.
    const cutoff = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(criteria.createdAt.type).toBe('lessThan');
    expect(criteria.createdAt.value.getTime()).toBe(cutoff.getTime());
    expect(patch).toEqual({ isDeleted: true, deletedAt: NOW });
  });

  it('never throws — a repo failure is swallowed', async () => {
    settingsFind.mockRejectedValue(new Error('db down'));
    await expect(service.sweep(NOW)).resolves.toBeUndefined();
  });
});
