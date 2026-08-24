import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as nodemailer from 'nodemailer';

import { EmailOutboxEntity } from './email-outbox.entity';

export interface MailRecipient {
  email: string;
  name?: string;
}

export interface MailSendOptions {
  to: string | string[] | MailRecipient | MailRecipient[];
  subject: string;
  html: string;
  text?: string;
  from?: { email: string; name?: string };
  cc?: string | string[];
  replyTo?: string;
  /** For the outbox record only — coarse UI grouping + org scoping. */
  category?: string;
  organizationId?: string | null;
}

/**
 * Driver-agnostic mailer, ported from the monolith's `MailService`.
 *
 * Three drivers, selected by `MAIL_DRIVER`:
 *   - `zeptomail` — ZeptoMail HTTPS API via plain fetch (prod).
 *   - `smtp`      — nodemailer SMTP (MailHog in dev, any SMTP server).
 *   - `outbox` (default) — no transport at all: the email is persisted to
 *     `email_outbox` with status `queued` and never transmitted. This is what
 *     lets dev/CI run with zero mail infra while still being fully verifiable.
 *
 * EVERY send — whatever the driver — is also written to `email_outbox` (status
 * `sent`/`failed` for the real drivers). Like the monolith, send() never throws;
 * it catches, logs, records, and returns a boolean. Email is out-of-band.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly driver: string;
  private readonly fromAddress: string;
  private readonly fromName: string;
  private transporter: nodemailer.Transporter | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(EmailOutboxEntity)
    private readonly outbox: Repository<EmailOutboxEntity>,
  ) {
    this.driver = (this.config.get<string>('MAIL_DRIVER') || 'outbox').toLowerCase();
    this.fromAddress =
      this.config.get<string>('MAIL_FROM') ||
      this.config.get<string>('ZEPTOMAIL_FROM') ||
      this.config.get<string>('SMTP_FROM') ||
      'no-reply@nugenova.com';
    this.fromName =
      this.config.get<string>('MAIL_FROM_NAME') ||
      this.config.get<string>('ZEPTOMAIL_FROM_NAME') ||
      'Nugenova';

    if (this.driver === 'smtp') {
      const port = Number(this.config.get<string>('SMTP_PORT') || '1025');
      const user = this.config.get<string>('SMTP_USER');
      const pass = this.config.get<string>('SMTP_PASS');
      this.transporter = nodemailer.createTransport({
        host: this.config.get<string>('SMTP_HOST') || 'localhost',
        port,
        ignoreTLS: port === 1025, // MailHog convention
        ...(user && pass ? { auth: { user, pass } } : {}),
      });
    }
    this.logger.log(`MailService driver = ${this.driver}, from = ${this.fromAddress}`);
  }

  private recipientList(to: MailSendOptions['to']): string[] {
    const arr = Array.isArray(to) ? to : [to];
    return arr
      .map((r) => (typeof r === 'string' ? r : r.email))
      .filter((e): e is string => !!e);
  }

  async send(opts: MailSendOptions): Promise<boolean> {
    const recipients = this.recipientList(opts.to);
    const record = this.outbox.create({
      organizationId: opts.organizationId ?? null,
      to: recipients.join(', '),
      subject: opts.subject,
      html: opts.html,
      category: opts.category ?? null,
      status: 'queued',
      driver: this.driver,
    });

    try {
      if (this.driver === 'zeptomail') {
        await this.sendViaZeptoMail(opts, recipients);
        record.status = 'sent';
        record.sentAt = new Date();
      } else if (this.driver === 'smtp') {
        await this.sendViaSmtp(opts, recipients);
        record.status = 'sent';
        record.sentAt = new Date();
      } else {
        // outbox driver: persist only, do not transmit.
        record.status = 'queued';
      }
    } catch (err) {
      record.status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Email send failed (${this.driver}) to ${record.to}: ${record.error}`,
      );
    }

    try {
      await this.outbox.save(record);
    } catch (err) {
      this.logger.error(
        `Failed to persist email_outbox record: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    return record.status !== 'failed';
  }

  private async sendViaSmtp(
    opts: MailSendOptions,
    recipients: string[],
  ): Promise<void> {
    if (!this.transporter) throw new Error('SMTP transporter not configured');
    await this.transporter.sendMail({
      from: `${opts.from?.name || this.fromName} <${opts.from?.email || this.fromAddress}>`,
      to: recipients.join(', '),
      subject: opts.subject,
      html: opts.html,
      ...(opts.text ? { text: opts.text } : {}),
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
  }

  private async sendViaZeptoMail(
    opts: MailSendOptions,
    recipients: string[],
  ): Promise<void> {
    const url =
      this.config.get<string>('ZEPTOMAIL_URL') ||
      'https://api.zeptomail.in/v1.1/email';
    const token = this.config.get<string>('ZEPTOMAIL_TOKEN');
    if (!token) throw new Error('ZEPTOMAIL_TOKEN not set');

    const payload = {
      from: {
        address: opts.from?.email || this.fromAddress,
        name: opts.from?.name || this.fromName,
      },
      to: recipients.map((address) => ({ email_address: { address } })),
      subject: opts.subject,
      htmlbody: opts.html,
      ...(opts.text ? { textbody: opts.text } : {}),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Zoho-enczapikey ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ZeptoMail ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}
