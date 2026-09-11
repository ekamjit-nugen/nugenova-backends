import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { DiscussionBoardEntity } from '../discussion-boards/entities/discussion-board.entity';
import { BoardNoteEntity } from '../discussion-boards/entities/board-note.entity';
import { BoardNodeEntity } from '../discussion-boards/entities/board-node.entity';
import { BoardCommentEntity } from '../discussion-boards/entities/board-comment.entity';

import { ClientEntity } from './entities/client.entity';
import { ClientContactEntity } from './entities/client-contact.entity';
import { ClientAssignmentEntity } from './entities/client-assignment.entity';
import { BoardClientShareEntity } from './entities/board-client-share.entity';
import { ClientAgreementEntity } from './entities/client-agreement.entity';
import { ClientDocumentEntity } from './entities/client-document.entity';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';

/**
 * Clients — client companies, their contacts + portal logins, the staff
 * assigned to them, and the boards shared with them. Gated on the `clients`
 * module. The global MailModule supplies portal-invite mail.
 */
@Module({
  imports: [
    AuthModule,
    NotificationModule,
    TypeOrmModule.forFeature([
      ClientEntity,
      ClientContactEntity,
      ClientAssignmentEntity,
      BoardClientShareEntity,
      ClientAgreementEntity,
      ClientDocumentEntity,
      OrgMembershipEntity,
      UserEntity,
      DiscussionBoardEntity,
      BoardNoteEntity,
      BoardNodeEntity,
      BoardCommentEntity,
    ]),
  ],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
