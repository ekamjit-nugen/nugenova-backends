import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConversationsService } from './services/conversations.service';
import {
  AddParticipantsDto,
  ConvertToGroupDto,
  CreateChannelDto,
  CreateDirectDto,
  CreateGroupDto,
  MarkUnreadDto,
  UpdateChannelDto,
} from './dto';

/**
 * Conversation surface (`/api/v1/chat/conversations`). Guarded by JWT only —
 * the real access boundary is participant membership + org scope, enforced in
 * the service (mirrors the monolith's "the real gate is membership" design).
 * The acting org + user ALWAYS come from req.user, never the request body.
 */
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  private truthy(v?: string): boolean {
    return v === '1' || v === 'true';
  }

  @Post('conversations/direct')
  @HttpCode(HttpStatus.CREATED)
  async createDirect(@Body() dto: CreateDirectDto, @Req() req: any) {
    const data = await this.conversations.createDirect(
      req.user.userId,
      dto.targetUserId,
      this.orgId(req),
    );
    return { success: true, message: 'Direct conversation created', data };
  }

  @Post('conversations/group')
  @HttpCode(HttpStatus.CREATED)
  async createGroup(@Body() dto: CreateGroupDto, @Req() req: any) {
    const data = await this.conversations.createGroup(
      dto.name,
      dto.description,
      dto.memberIds,
      req.user.userId,
      this.orgId(req),
    );
    return { success: true, message: 'Group created successfully', data };
  }

  @Post('conversations/channel')
  @HttpCode(HttpStatus.CREATED)
  async createChannel(@Body() dto: CreateChannelDto, @Req() req: any) {
    const data = await this.conversations.createChannel(
      dto.name,
      dto.description,
      req.user.userId,
      this.orgId(req),
      dto.memberIds,
      dto.channelType,
      dto.topic,
      dto.categoryId,
    );
    return { success: true, message: 'Channel created successfully', data };
  }

  @Patch('conversations/:id')
  async updateChannel(@Param('id') id: string, @Body() dto: UpdateChannelDto, @Req() req: any) {
    const data = await this.conversations.updateChannel(
      id,
      this.orgId(req),
      req.user.userId,
      req.user.orgRole,
      dto,
    );
    return { success: true, message: 'Channel updated', data };
  }

  @Delete('conversations/:id')
  async deleteChannel(@Param('id') id: string, @Req() req: any) {
    await this.conversations.deleteChannel(id, this.orgId(req), req.user.userId, req.user.orgRole);
    return { success: true, message: 'Channel deleted' };
  }

  @Get('conversations')
  async getMine(
    @Req() req: any,
    @Query('starred') starred?: string,
    @Query('starredOnly') starredOnly?: string,
  ) {
    const onlyStarred = this.truthy(starred) || this.truthy(starredOnly);
    const data = await this.conversations.getMyConversations(req.user.userId, this.orgId(req), {
      starredOnly: onlyStarred,
    });
    return { success: true, message: 'Conversations retrieved', data };
  }

  @Get('conversations/self')
  async getSelf(@Req() req: any) {
    const data = await this.conversations.getOrCreateSelf(req.user.userId, this.orgId(req));
    return { success: true, message: 'Self conversation retrieved', data };
  }

  // The people the caller can start a DM with / @mention. Unlike /org/members
  // (admin-only), this is available to any member — messaging is not an admin
  // action. Scoped to the caller's org; excludes the caller.
  @Get('directory')
  async directory(@Req() req: any) {
    const data = await this.conversations.directory(this.orgId(req), req.user.userId);
    return { success: true, message: 'Directory retrieved', data };
  }

  @Get('conversations/:id')
  async getOne(@Param('id') id: string, @Req() req: any) {
    const data = await this.conversations.getConversation(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Conversation retrieved', data };
  }

  @Post('conversations/:id/participants')
  @HttpCode(HttpStatus.OK)
  async addParticipants(@Param('id') id: string, @Body() dto: AddParticipantsDto, @Req() req: any) {
    const data = await this.conversations.addParticipants(
      id,
      this.orgId(req),
      dto.userIds,
      req.user.userId,
    );
    return { success: true, message: 'Participants added successfully', data };
  }

  @Delete('conversations/:id/participants/:userId')
  async removeParticipant(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    const data = await this.conversations.removeParticipant(
      id,
      this.orgId(req),
      userId,
      req.user.userId,
    );
    return { success: true, message: 'Participant removed successfully', data };
  }

  @Post('conversations/:id/leave')
  @HttpCode(HttpStatus.OK)
  async leave(@Param('id') id: string, @Req() req: any) {
    const result = await this.conversations.leave(id, this.orgId(req), req.user.userId);
    return { success: true, ...result };
  }

  @Put('conversations/:id/pin')
  async pin(@Param('id') id: string, @Req() req: any) {
    const data = await this.conversations.togglePin(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Pin toggled', data };
  }

  @Put('conversations/:id/mute')
  async mute(@Param('id') id: string, @Req() req: any) {
    const data = await this.conversations.toggleMute(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Mute toggled', data };
  }

  @Put('conversations/:id/star')
  async star(@Param('id') id: string, @Req() req: any) {
    const data = await this.conversations.toggleStar(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Star toggled', data };
  }

  @Put('conversations/:id/unarchive')
  async unarchive(@Param('id') id: string, @Req() req: any) {
    const data = await this.conversations.unarchive(id, this.orgId(req), req.user.userId);
    return { success: true, message: 'Conversation unarchived', data };
  }

  @Post('conversations/:id/convert-group')
  @HttpCode(HttpStatus.OK)
  async convertToGroup(@Param('id') id: string, @Body() dto: ConvertToGroupDto, @Req() req: any) {
    const data = await this.conversations.convertToGroup(
      id,
      this.orgId(req),
      req.user.userId,
      dto.memberIds,
      dto.groupName,
    );
    return { success: true, message: 'Conversation converted to group', data };
  }

  @Put('conversations/:id/unread')
  async markUnread(@Param('id') id: string, @Body() dto: MarkUnreadDto, @Req() req: any) {
    await this.conversations.markUnread(id, this.orgId(req), req.user.userId, dto.fromMessageId);
    return { success: true, message: 'Marked as unread' };
  }
}
