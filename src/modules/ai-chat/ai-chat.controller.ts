import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiChatService } from './services/ai-chat.service';
import { CreateConversationDto, SendMessageDto } from './dto';

/**
 * AI chatbot HTTP surface — `/api/v1/ai/chat/*`, all JWT-guarded and org-scoped.
 * The acting org + user ALWAYS come from `req.user` (the trusted JWT), never the
 * body, so a user can only ever read/write their OWN conversations.
 *
 *   POST   /ai/chat/conversations            — create a conversation
 *   GET    /ai/chat/conversations            — list own conversations (newest first)
 *   GET    /ai/chat/conversations/:id        — conversation + messages
 *   POST   /ai/chat/conversations/:id/messages — send (fires the async job)
 *   GET    /ai/chat/messages/:id             — poll one message (pending→done/error)
 *   DELETE /ai/chat/conversations/:id        — delete a conversation
 */
@Controller('ai/chat')
@UseGuards(JwtAuthGuard)
export class AiChatController {
  constructor(private readonly chat: AiChatService) {}

  private orgId(req: any): string | null {
    return req.user?.organizationId ?? null;
  }

  private userId(req: any): string {
    const id = req.user?.userId;
    if (!id) throw new ForbiddenException('No user context');
    return id;
  }

  @Post('conversations')
  async create(@Req() req: any, @Body() dto: CreateConversationDto) {
    const conv = await this.chat.createConversation(this.orgId(req), this.userId(req), dto.title);
    return {
      success: true,
      data: {
        id: conv.id,
        title: conv.title,
        lastMessageAt: conv.lastMessageAt,
        createdAt: conv.createdAt,
      },
    };
  }

  @Get('conversations')
  async list(@Req() req: any) {
    const data = await this.chat.listConversations(this.orgId(req), this.userId(req));
    return { success: true, data };
  }

  @Get('conversations/:id')
  async getOne(@Req() req: any, @Param('id') id: string) {
    const data = await this.chat.getConversation(this.orgId(req), this.userId(req), id);
    return { success: true, data };
  }

  @Post('conversations/:id/messages')
  async send(@Req() req: any, @Param('id') id: string, @Body() dto: SendMessageDto) {
    const data = await this.chat.sendMessage(this.orgId(req), this.userId(req), id, dto.content);
    return { success: true, data };
  }

  @Get('messages/:id')
  async getMessage(@Req() req: any, @Param('id') id: string) {
    const data = await this.chat.getMessage(this.orgId(req), this.userId(req), id);
    return { success: true, data };
  }

  @Delete('conversations/:id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const data = await this.chat.deleteConversation(this.orgId(req), this.userId(req), id);
    return { success: true, data };
  }
}
