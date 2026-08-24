import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { AdminPlaybooksService } from './admin-playbooks.service';

/**
 * Super-admin-only migration playbooks. Effective paths (global prefix):
 * `GET /api/v1/admin/playbooks` and `GET /api/v1/admin/playbooks/:module`.
 * Guarded by JWT + platform-admin so only the super-admin account can read them.
 */
@Controller('admin/playbooks')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminPlaybooksController {
  constructor(private readonly service: AdminPlaybooksService) {}

  @Get()
  async list() {
    const data = await this.service.list();
    return { success: true, data };
  }

  @Get(':module')
  async get(@Param('module') module: string) {
    const data = await this.service.get(module);
    return { success: true, data };
  }

  /**
   * Live test run — streams one Server-Sent Event per test as the module's suites
   * execute, so the viewer can show results in real time. Call via `fetch` with
   * the Bearer token (EventSource can't send auth headers). Guarded to super-admin.
   */
  @Get(':module/run')
  async run(
    @Param('module') module: string,
    @Req() req: any,
    @Res() res: any,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    const send = (obj: any) => {
      if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    try {
      await this.service.runModuleTests(module, send);
    } catch (e: any) {
      send({ type: 'error', message: String(e?.message || e) });
      send({ type: 'done', aborted: true });
    }
    if (!closed) res.end();
  }
}
