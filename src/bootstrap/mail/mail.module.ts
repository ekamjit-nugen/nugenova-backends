import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MailService } from './mail.service';
import { EmailOutboxEntity } from './email-outbox.entity';

/**
 * Global mailer. Ported from the monolith's `@Global() MailModule` so any module
 * can inject `MailService` without re-importing. Owns the `email_outbox` table.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([EmailOutboxEntity])],
  providers: [MailService],
  exports: [MailService, TypeOrmModule],
})
export class MailModule {}
