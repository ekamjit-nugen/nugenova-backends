import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DiscussionBoardsService } from './discussion-boards.service';

/**
 * Discussion-boards (communication board) HTTP surface — `/api/v1/discussion-boards/*`,
 * JWT-guarded and org-scoped. The acting org ALWAYS comes from `req.user`.
 *
 *   GET /discussion-boards      — the org's boards (+ note/participant counts)
 *   GET /discussion-boards/:id  — a board with its notes, nodes and comments
 */
@Controller('discussion-boards')
@UseGuards(JwtAuthGuard)
export class DiscussionBoardsController {
  constructor(private readonly boards: DiscussionBoardsService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }

  @Get()
  async list(@Req() req: any) {
    return { success: true, data: await this.boards.listBoards(this.orgId(req)) };
  }

  @Get(':id')
  async board(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.boards.getBoard(this.orgId(req), id) };
  }
}
