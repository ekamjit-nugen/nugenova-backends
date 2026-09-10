import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

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

  /** Files (images/assets) shared on a board. */
  @Get(':boardId/files')
  async files(@Req() req: any, @Param('boardId') boardId: string) {
    return { success: true, data: await this.boards.getBoardFiles(this.orgId(req), this.caller(req), boardId) };
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
