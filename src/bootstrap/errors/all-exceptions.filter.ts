import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'crypto';

import { ErrorReporterService } from './error-reporter.service';

/**
 * The one place a failed request is turned into a response.
 *
 * Every exception that escapes a handler lands here, gets a short reference id,
 * and is filed with {@link ErrorReporterService}: an activity row for the org
 * (so failures are visible in the activity log alongside everything else) and,
 * for 5xx, an email carrying the complete reason.
 *
 * What the caller gets back is deliberately asymmetric:
 *   • 4xx keeps the handler's own body — those messages are written for users
 *     and the frontend reads them.
 *   • 5xx is replaced with a neutral message plus the reference, because the
 *     real reason (stack, SQL, file paths) belongs in the log and the alert,
 *     not in a browser.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Request');

  constructor(private readonly reporter: ErrorReporterService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<any>();
    const res = ctx.getResponse<any>();

    // Not an HTTP request (a websocket or scheduled job) — nothing to answer.
    if (!res?.status || typeof res.status !== 'function') {
      this.logger.error(`non-http exception: ${describe(exception)}`);
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const reference = randomBytes(4).toString('hex');
    const message = describe(exception);
    const method = req?.method ?? 'UNKNOWN';
    const path = req?.originalUrl ?? req?.url ?? 'unknown';

    if (status >= 500) {
      this.logger.error(`[${reference}] ${status} ${method} ${path} — ${message}`, stackOf(exception));
    } else {
      this.logger.warn(`[${reference}] ${status} ${method} ${path} — ${message}`);
    }

    // Reporting is deliberately not awaited: the caller should not wait on a
    // database write and an SMTP round trip to receive their error.
    void this.reporter
      .report({
        reference,
        status,
        method,
        path,
        message,
        stack: stackOf(exception),
        organizationId: req?.user?.organizationId ?? null,
        userId: req?.user?.userId ?? null,
        userEmail: req?.user?.email ?? null,
        ip: ipOf(req),
        at: new Date(),
      })
      .catch((e) => this.logger.warn(`[${reference}] reporting failed: ${(e as Error).message}`));

    if (status >= 500) {
      res.status(status).json({
        statusCode: status,
        message: 'Something went wrong on our side. The team has been notified.',
        reference,
      });
      return;
    }

    // Keep the handler's own 4xx body verbatim, adding only the reference.
    const body = exception instanceof HttpException ? exception.getResponse() : { message };
    res
      .status(status)
      .json(
        typeof body === 'string'
          ? { statusCode: status, message: body, reference }
          : { statusCode: status, ...(body as object), reference },
      );
  }
}

function describe(exception: unknown): string {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (typeof body === 'string') return body;
    const msg = (body as any)?.message;
    if (Array.isArray(msg)) return msg.join('; '); // class-validator returns a list
    if (typeof msg === 'string') return msg;
    return exception.message;
  }
  if (exception instanceof Error) return exception.message || exception.name;
  return typeof exception === 'string' ? exception : JSON.stringify(exception);
}

function stackOf(exception: unknown): string | undefined {
  return exception instanceof Error ? exception.stack : undefined;
}

function ipOf(req: any): string | null {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req?.ip ?? null;
}
