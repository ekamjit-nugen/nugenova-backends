import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ActivityRetentionService } from './activity-retention.service';

/**
 * Drives activity-log retention. Runs daily; the per-org 15-day cadence + lock
 * live in {@link ActivityRetentionService} (a daily tick is cheap and lets an
 * org that was skipped — locked / owner-less — catch up the next day).
 */
@Injectable()
export class ActivityCronService {
  private readonly logger = new Logger(ActivityCronService.name);

  constructor(private readonly retention: ActivityRetentionService) {}

  // 03:20 every day — off-peak.
  @Cron('20 3 * * *')
  async cronRetention(): Promise<void> {
    try {
      const n = await this.retention.runAll();
      if (n > 0) this.logger.log(`Activity retention archived ${n} row(s) across orgs`);
    } catch (err) {
      this.logger.error(`Activity retention cron failed: ${(err as Error).message}`);
    }
  }
}
