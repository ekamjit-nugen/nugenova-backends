import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthService } from '../auth.service';

/**
 * Postgres has no TTL indexes, so expired sessions and revoked-token rows are
 * swept here on a schedule (the Mongo schema relied on `expireAfterSeconds`).
 * Reads never trust an expired row regardless — this just stops the tables from
 * growing unbounded.
 */
@Injectable()
export class SessionSweepService {
  private readonly logger = new Logger(SessionSweepService.name);

  constructor(private readonly authService: AuthService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    try {
      const { sessions, tokens } = await this.authService.sweepExpired();
      if (sessions || tokens) {
        this.logger.log(
          `Swept ${sessions} expired session(s), ${tokens} revoked-token row(s).`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Session sweep failed: ${err?.message || err}`);
    }
  }
}
