import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BoardCaller, DiscussionBoardsService } from './discussion-boards.service';
import { AddParticipantDto, CreateNoteDto, UpdateNoteDto } from './dto';

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

  /** Participant-access context from the trusted JWT. */
  private caller(req: any): BoardCaller {
    return {
      userId: req.user?.userId,
      isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin',
    };
  }

  @Get()
  async list(@Req() req: any) {
    return { success: true, data: await this.boards.listBoards(this.orgId(req), this.caller(req)) };
  }

  /** Every board file the caller can access — for the Cloud Drive. Declared
   *  before `:id`/`:boardId/files` so the literal path wins. */
  @Get('mine/files')
  async myFiles(@Req() req: any) {
    return { success: true, data: await this.boards.listAccessibleBoardFiles(this.orgId(req), this.caller(req)) };
  }

  @Get(':id')
  async board(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.boards.getBoard(this.orgId(req), id, this.caller(req)) };
  }

  /** Create a new card on a board. */
  @Post(':boardId/notes')
  async createNote(@Req() req: any, @Param('boardId') boardId: string, @Body() dto: CreateNoteDto) {
    const note = await this.boards.createNote(this.orgId(req), this.caller(req), boardId, dto);
    return { success: true, data: note };
  }

  /** Edit a card — content, colour, due date or completion. */
  @Patch(':boardId/notes/:noteId')
  async updateNote(
    @Req() req: any,
    @Param('boardId') boardId: string,
    @Param('noteId') noteId: string,
    @Body() dto: UpdateNoteDto,
  ) {
    const note = await this.boards.updateNote(this.orgId(req), this.caller(req), boardId, noteId, dto);
    return { success: true, data: note };
  }

  /** Upload an image for a note (returns a stable URL to embed). */
  @Post(':boardId/assets')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAsset(
    @Req() req: any,
    @Param('boardId') boardId: string,
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    const data = await this.boards.uploadAsset(this.orgId(req), this.caller(req), boardId, file);
    return { success: true, data };
  }

  /** Copy a Cloud Drive file onto this board (access-checked on both sides). */
  @Post(':boardId/assets/from-drive')
  async copyDriveFile(@Req() req: any, @Param('boardId') boardId: string, @Body() body: { fileId?: string }) {
    if (!body?.fileId) throw new BadRequestException('fileId is required');
    const data = await this.boards.copyDriveFile(this.orgId(req), this.caller(req), boardId, body.fileId);
    return { success: true, data };
  }

  /** Bytes of a copied (non-image) board file — board participants only. */
  @Get(':boardId/files/:assetId/raw')
  async boardFileRaw(@Req() req: any, @Param('boardId') boardId: string, @Param('assetId') assetId: string, @Res() res: Response) {
    const f = await this.boards.getBoardFileBytes(this.orgId(req), this.caller(req), boardId, assetId);
    res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${f.filename.replace(/[^\w.\-]+/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(f.buffer);
  }

  /** Files (images/assets) shared on a board. */
  @Get(':boardId/files')
  async files(@Req() req: any, @Param('boardId') boardId: string) {
    return { success: true, data: await this.boards.getBoardFiles(this.orgId(req), this.caller(req), boardId) };
  }

  /** Delete a card. */
  @Delete(':boardId/notes/:noteId')
  async deleteNote(@Req() req: any, @Param('boardId') boardId: string, @Param('noteId') noteId: string) {
    return { success: true, data: await this.boards.deleteNote(this.orgId(req), this.caller(req), boardId, noteId) };
  }

  /** Add a member to the board. */
  @Post(':boardId/participants')
  async addParticipant(@Req() req: any, @Param('boardId') boardId: string, @Body() dto: AddParticipantDto) {
    const board = await this.boards.addParticipant(this.orgId(req), this.caller(req), boardId, dto);
    return { success: true, data: board };
  }

  /** Remove a member from the board. */
  @Delete(':boardId/participants/:userId')
  async removeParticipant(@Req() req: any, @Param('boardId') boardId: string, @Param('userId') userId: string) {
    const board = await this.boards.removeParticipant(this.orgId(req), this.caller(req), boardId, userId);
    return { success: true, data: board };
  }
}
