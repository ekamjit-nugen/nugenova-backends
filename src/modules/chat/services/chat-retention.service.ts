import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { MessageEntity } from '../entities/message.entity';
import { OrgChatSettingEntity } from '../entities/org-chat-setting.entity';

/**
 * Message-retention sweep. For every org whose chat policy sets
 * `retentionDays > 0`, soft-deletes messages older than that window. Runs nightly
 * (single node — see the presence PLAYBOOK note on multi-node). `now` is
 * injectable so the core can be unit-tested. Fail-safe: never throws.
 */
@Injectable()
export class ChatRetentionService {
  private readonly logger = new Logger(ChatRetentionService.name);

  constructor(
    @InjectRepository(MessageEntity)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(OrgChatSettingEntity)
    private readonly settings: Repository<OrgChatSettingEntity>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweep(now: Date = new Date()): Promise<void> {
    try {
      const rows = await this.settings.find();
      for (const row of rows) {
        const days = Number(row.settings?.retentionDays) || 0;
        if (days <= 0) continue;
        const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        const res = await this.messages.update(
          {
            organizationId: row.organizationId,
            isDeleted: false,
            createdAt: LessThan(cutoff),
          },
          { isDeleted: true, deletedAt: now },
        );
        if (res.affected) {
          this.logger.log(
            `retention: soft-deleted ${res.affected} messages in org ${row.organizationId} (older than ${days}d)`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`chat retention sweep failed: ${String(err)}`);
    }
  }
}
