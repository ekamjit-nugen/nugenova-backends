import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from '../../bootstrap/storage/storage.service';
import { MessagesService } from './services/messages.service';
import { BookmarksService } from './services/bookmarks.service';
import {
  EditMessageDto,
  ForwardMessageDto,
  MessageQueryDto,
  SearchMessageDto,
  SendMessageDto,
} from './dto';

/**
 * Message surface (`/api/v1/chat`). Guarded by JWT only — access is enforced by
 * participant membership + org scope in the service. Acting org + user ALWAYS
 * come from req.user.
 *
 * Realtime broadcast (Socket.IO) is deferred — see PLAYBOOK.md. Sends persist
 * and are read back over REST/poll, matching the current Nexora notification
 * module's REST-poll posture.
 */
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly bookmarks: BookmarksService,
    private readonly storage: StorageService,
  ) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  private senderName(req: any): string | undefined {
    return [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || undefined;
  }

  // ── attachments ─────────────────────────────────────────────────────────────

  /**
   * Upload any file for a chat attachment (multipart `file`, ≤25 MB). Stored via
   * StorageService (S3 or the Postgres-bytea fallback), scoped to the caller's
   * org + userId. Blocked-extension and size caps are enforced inside
   * StorageService.save. Returns the attachment metadata the client then echoes
   * back on the send (`fileId`/`fileName`/`fileSize`/`fileMimeType`).
   */
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  async upload(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('No file provided');
    }
    const meta = await this.storage.save({
      organizationId: this.orgId(req),
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: req.user.userId,
      category: 'chat',
    });
    return {
      success: true,
      message: 'File uploaded',
      data: {
        fileId: meta.id,
        fileName: meta.originalName,
        fileSize: meta.size,
        fileMimeType: meta.mimeType,
      },
    };
  }

  /**
   * Serve a chat attachment, access-checked: the caller must be a participant of
   * a same-org conversation that contains a message referencing this `fileId`.
   * On no access → 404 (never leak the file's existence).
   *
   * SECURITY: the bytes are streamed through THIS authenticated endpoint — we
   * never 302 to a presigned S3 URL (that would be auth-free and copy-pasteable
   * from the Network tab; all chat files are confidential). For S3 the app fetches
   * the object server-side with its own credentials and pipes it back; opening
   * the raw URL in a new tab carries no bearer token → 401. The bytea fallback
   * streams the stored bytes the same way.
   */
  @Get('files/:fileId')
  async serveFile(
    @Param('fileId') fileId: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const allowed = await this.messages.userCanAccessFile(
      fileId,
      this.orgId(req),
      req.user.userId,
    );
    if (!allowed) throw new NotFoundException('File not found');

    const file = await this.storage.getMeta(fileId); // 404s if the row is gone
    const { stream, mimeType, filename, size } = await this.storage.openStream(file);

    const safeName = filename.replace(/[^\w.\-]+/g, '_');
    // Inline for viewables (rendered in-page), attachment (forced download) for
    // everything else.
    const viewable = /^(image|video|audio)\//.test(mimeType) || mimeType === 'application/pdf';
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `${viewable ? 'inline' : 'attachment'}; filename="${safeName}"`,
    );
    if (size != null) res.setHeader('Content-Length', String(size));
    res.setHeader('Cache-Control', 'private, no-store');

    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  async send(@Param('id') id: string, @Body() dto: SendMessageDto, @Req() req: any) {
    // Attachment contract: the client uploads via POST /chat/upload then echoes
    // back `fileId` (+ fileName/fileSize/fileMimeType) — it does NOT send a
    // `fileUrl` (URLs are resolved on demand by GET /chat/files/:fileId). Gate on
    // any attachment field so a fileId-only send is persisted, not dropped.
    const hasAttachment = !!(dto.fileId || dto.fileUrl);
    const fileData = hasAttachment
      ? {
          fileUrl: dto.fileUrl,
          fileName: dto.fileName,
          fileSize: dto.fileSize,
          fileMimeType: dto.fileMimeType,
          fileId: dto.fileId,
        }
      : undefined;
    const data = await this.messages.sendMessage(
      id,
      this.orgId(req),
      req.user.userId,
      dto.content,
      dto.type,
      dto.replyTo,
      this.senderName(req),
      fileData,
      dto.idempotencyKey,
      dto.mentions,
    );
    return { success: true, message: 'Message sent', data };
  }

  @Get('conversations/:id/messages')
  async list(@Param('id') id: string, @Query() query: MessageQueryDto, @Req() req: any) {
    const result = await this.messages.getMessages(
      id,
      this.orgId(req),
      req.user.userId,
      query.page,
      query.limit,
      query.order,
    );
    return {
      success: true,
      message: 'Messages retrieved',
      data: result.data,
      pagination: result.pagination,
    };
  }

  @Put('messages/:id')
  async edit(@Param('id') id: string, @Body() dto: EditMessageDto, @Req() req: any) {
    const data = await this.messages.editMessage(id, this.orgId(req), req.user.userId, dto.content);
    return { success: true, message: 'Message edited successfully', data };
  }

  @Delete('messages/:id')
  async remove(@Param('id') id: string, @Req() req: any) {
    const result = await this.messages.deleteMessage(id, this.orgId(req), req.user.userId);
    return { success: true, ...result };
  }

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(@Param('id') id: string, @Req() req: any) {
    const result = await this.messages.markAsRead(id, this.orgId(req), req.user.userId);
    return { success: true, ...result };
  }

  @Post('messages/:id/reactions')
  @HttpCode(HttpStatus.OK)
  async react(@Param('id') id: string, @Body() body: { emoji: string }, @Req() req: any) {
    const data = await this.messages.addReaction(id, this.orgId(req), req.user.userId, body.emoji);
    return { success: true, message: 'Reaction updated', data };
  }

  @Get('unread')
  async unread(@Req() req: any) {
    const data = await this.messages.getUnreadCount(req.user.userId, this.orgId(req));
    return { success: true, message: 'Unread count retrieved', data };
  }

  @Get('conversations/:id/search')
  async search(@Param('id') id: string, @Query() query: SearchMessageDto, @Req() req: any) {
    const data = await this.messages.searchMessages(id, this.orgId(req), query.q, req.user.userId);
    return { success: true, message: 'Search results', data };
  }

  // ── pin / unpin ─────────────────────────────────────────────────────────────

  @Put('messages/:id/pin')
  async pin(@Param('id') id: string, @Req() req: any) {
    const data = await this.messages.pinMessage(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Message pinned', data };
  }

  @Put('messages/:id/unpin')
  async unpin(@Param('id') id: string, @Req() req: any) {
    const data = await this.messages.unpinMessage(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Message unpinned', data };
  }

  @Get('conversations/:id/pinned')
  async pinned(@Param('id') id: string, @Req() req: any) {
    const data = await this.messages.getPinnedMessages(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Pinned messages retrieved', data };
  }

  // ── forward ───────────────────────────────────────────────────────────────

  @Post('messages/:id/forward')
  @HttpCode(HttpStatus.CREATED)
  async forward(@Param('id') id: string, @Body() dto: ForwardMessageDto, @Req() req: any) {
    const data = await this.messages.forwardMessage(
      id,
      this.orgId(req),
      req.user.userId,
      dto.conversationIds,
      this.senderName(req),
    );
    return { success: true, message: 'Message forwarded', data };
  }

  // ── bookmark / save ─────────────────────────────────────────────────────────

  @Put('messages/:id/bookmark')
  async bookmark(@Param('id') id: string, @Req() req: any) {
    const data = await this.bookmarks.saveBookmark(this.orgId(req), req.user.userId, id);
    return { success: true, message: 'Message bookmarked', data };
  }

  @Delete('messages/:id/bookmark')
  async unbookmark(@Param('id') id: string, @Req() req: any) {
    const result = await this.bookmarks.removeBookmark(this.orgId(req), req.user.userId, id);
    return { success: true, ...result };
  }

  @Get('bookmarks')
  async listBookmarks(@Req() req: any) {
    const data = await this.bookmarks.getBookmarks(this.orgId(req), req.user.userId);
    return { success: true, message: 'Bookmarks retrieved', data };
  }

  @Get('conversations/:convId/messages/:msgId/read-status')
  async readStatus(
    @Param('convId') convId: string,
    @Param('msgId') msgId: string,
    @Req() req: any,
  ) {
    const data = await this.messages.getReadStatus(
      convId,
      this.orgId(req),
      msgId,
      req.user.userId,
    );
    return { success: true, data };
  }
}
