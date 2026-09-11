import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ClientsService } from './clients.service';

/**
 * Daily sweep that reminds clients about agreements they've been sent but not
 * signed — after a few days, then a couple more times, capped. Delegates to
 * {@link ClientsService.runAgreementReminders}. Fail-safe: errors are logged,
 * never thrown.
 */
@Injectable()
export class ClientsCronService {
  private readonly logger = new Logger(ClientsCronService.name);

  constructor(private readonly clients: ClientsService) {}

  // Every day at 09:00.
  @Cron('0 9 * * *')
  async remindUnsignedAgreements(): Promise<void> {
    try {
      const r = await this.clients.runAgreementReminders();
      if (r.notified) this.logger.log(`agreement reminders: checked=${r.checked} notified=${r.notified}`);
    } catch (err) {
      this.logger.error(`agreement reminder sweep failed: ${String(err)}`);
    }
  }
}
