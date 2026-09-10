import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { DiscussionBoardsService } from './discussion-boards.service';

/**
 * Hourly deadline-reminder sweep for board cards/action items. Delegates to
 * {@link DiscussionBoardsService.runDueReminders}, which fires each stage
 * (a day before → on the day → overdue) once per note and stops when a note is
 * marked complete. Fail-safe: a sweep error is logged, never thrown.
 */
@Injectable()
export class DiscussionBoardsCronService {
  private readonly logger = new Logger(DiscussionBoardsCronService.name);

  constructor(private readonly boards: DiscussionBoardsService) {}

  @Cron('0 * * * *')
  async sweep(): Promise<void> {
    try {
      const r = await this.boards.runDueReminders();
      if (r.notified) this.logger.log(`board due reminders: checked=${r.checked} notified=${r.notified}`);
    } catch (err) {
      this.logger.error(`board due reminder sweep failed: ${String(err)}`);
    }
  }
}
