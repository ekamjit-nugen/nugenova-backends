import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { ConversationEntity } from './entities/conversation.entity';
import { MessageEntity } from './entities/message.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { ConversationsService } from './services/conversations.service';
import { MessagesService } from './services/messages.service';
import { ConversationsController } from './conversations.controller';
import { MessagesController } from './messages.controller';

/**
 * Chat / messaging — direct/group/channel/self conversations + messages
 * (send/list/edit/delete/read/react/search). Ported from the Mongo
 * chat-service. Guarded by JwtAuthGuard; every read/write is scoped to
 * organizationId AND the caller's userId (tenant + user isolation).
 *
 * Deferred to follow-ups (see PLAYBOOK.md): the Socket.IO realtime gateway
 * (presence/typing/live delivery), threads, polls, moderation/DLP,
 * link-preview, slash-commands, managed client channels, and the frontend UI.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([ConversationEntity, MessageEntity, UserEntity]),
  ],
  controllers: [ConversationsController, MessagesController],
  providers: [ConversationsService, MessagesService],
  exports: [ConversationsService, MessagesService],
})
export class ChatModule {}
