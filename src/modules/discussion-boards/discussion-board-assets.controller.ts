import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

import { DiscussionBoardsService } from './discussion-boards.service';

/**
 * PUBLIC board-image serve. Notes embed `<img src>` tags, which cannot send an
 * auth header, so board images are served by their unguessable 24-char id
 * WITHOUT JwtAuthGuard — matching the legacy `/discussion-board/img/<token>`
 * posture. It only ever serves files tagged `board-asset` (enforced in the
 * service), so it can never expose confidential documents.
 *
 * Separate controller (no class-level guard) at a 2-segment path that never
 * collides with the guarded `GET /discussion-boards/:id`.
 */
@Controller('discussion-boards/assets')
export class DiscussionBoardAssetsController {
  constructor(private readonly boards: DiscussionBoardsService) {}

  @Get(':id')
  async asset(@Param('id') id: string, @Res() res: Response) {
    const { buffer, mimeType, filename } = await this.boards.getAssetBytes(id);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // Board images are embedded via <img> and may be loaded cross-origin (the
    // web app and API can be on different origins in dev); allow embedding.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(buffer);
  }
}
