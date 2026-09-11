import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { DiscussionBoardEntity } from '../discussion-boards/entities/discussion-board.entity';

import { ClientEntity } from './entities/client.entity';
import { ClientContactEntity } from './entities/client-contact.entity';
import { ClientAssignmentEntity } from './entities/client-assignment.entity';
import { BoardClientShareEntity } from './entities/board-client-share.entity';
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
    TypeOrmModule.forFeature([
      ClientEntity,
      ClientContactEntity,
      ClientAssignmentEntity,
      BoardClientShareEntity,
      OrgMembershipEntity,
      UserEntity,
      DiscussionBoardEntity,
    ]),
  ],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
