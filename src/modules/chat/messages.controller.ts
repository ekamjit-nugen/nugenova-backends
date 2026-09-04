import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MessagesService } from './services/messages.service';
import {
  EditMessageDto,
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
  constructor(private readonly messages: MessagesService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  private senderName(req: any): string | undefined {
    return [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || undefined;
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  async send(@Param('id') id: string, @Body() dto: SendMessageDto, @Req() req: any) {
    const fileData = dto.fileUrl
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
