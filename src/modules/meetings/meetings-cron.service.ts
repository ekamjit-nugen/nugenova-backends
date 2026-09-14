import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { MeetingsService } from './meetings.service';

/**
 * Hourly sweep that auto-ends abandoned live meetings so they don't linger in
 * "Live now". Recurring meetings' rooms persist. Fail-safe: errors are logged.
 */
@Injectable()
export class MeetingsCronService {
  private readonly logger = new Logger(MeetingsCronService.name);

  constructor(private readonly meetings: MeetingsService) {}

  @Cron('0 * * * *')
  async sweep(): Promise<void> {
    try {
      const ended = await this.meetings.endStale();
      if (ended) this.logger.log(`auto-ended ${ended} stale meeting(s)`);
    } catch (err) {
      this.logger.error(`meeting auto-end sweep failed: ${String(err)}`);
    }
  }
}
