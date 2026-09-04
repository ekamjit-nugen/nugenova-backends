import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { StorageModule } from '../../bootstrap/storage/storage.module';
import { ConversationEntity } from './entities/conversation.entity';
import { MessageEntity } from './entities/message.entity';
import { ChatBookmarkEntity } from './entities/chat-bookmark.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { LeaveRequestEntity } from '../leave/entities/leave-request.entity';
import { ConversationsService } from './services/conversations.service';
import { MessagesService } from './services/messages.service';
import { BookmarksService } from './services/bookmarks.service';
import { ConversationsController } from './conversations.controller';
import { MessagesController } from './messages.controller';
import { PresenceService } from './realtime/presence.service';
import { ChatGateway } from './realtime/chat.gateway';

/**
 * Chat / messaging — direct/group/channel/self conversations + messages
 * (send/list/edit/delete/read/react/search). Ported from the Mongo
 * chat-service. Guarded by JwtAuthGuard; every read/write is scoped to
 * organizationId AND the caller's userId (tenant + user isolation).
 *
 * Realtime (this tranche): the Socket.IO `/chat` gateway + PresenceService give
 * presence (online/away/offline/on-holiday), typing relay, and live
 * message/edit/delete delivery (fanned out via EventEmitter2, no gateway↔service
 * circular dep). Presence is single-node in-memory — multi-node would need a
 * Redis socket.io adapter + shared presence store (see PLAYBOOK.md).
 *
 * Deferred to follow-ups (see PLAYBOOK.md): threads, polls, moderation/DLP,
 * link-preview, slash-commands, managed client channels, and the frontend UI.
 */
@Module({
  imports: [
    AuthModule,
    NotificationModule,
    StorageModule,
    TypeOrmModule.forFeature([
      ConversationEntity,
      MessageEntity,
      ChatBookmarkEntity,
      UserEntity,
      OrgMembershipEntity,
      LeaveRequestEntity,
    ]),
  ],
  controllers: [ConversationsController, MessagesController],
  providers: [ConversationsService, MessagesService, BookmarksService, PresenceService, ChatGateway],
  exports: [ConversationsService, MessagesService, BookmarksService, PresenceService],
})
export class ChatModule {}
