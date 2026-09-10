import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';

import { DiscussionBoardEntity } from './entities/discussion-board.entity';
import { BoardNoteEntity } from './entities/board-note.entity';
import { BoardNodeEntity } from './entities/board-node.entity';
import { BoardCommentEntity } from './entities/board-comment.entity';
import { DiscussionBoardsService } from './discussion-boards.service';
import { DiscussionBoardsController } from './discussion-boards.controller';
import { DiscussionBoardAssetsController } from './discussion-board-assets.controller';

/**
 * Discussion boards — the collaborative "communication board" ported from the
 * legacy Mongo `discussionboards` family. Stage 0: entities/tables + a viewer
 * read API over the migrated data; live collaboration/editing is a later phase.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      DiscussionBoardEntity,
      BoardNoteEntity,
      BoardNodeEntity,
      BoardCommentEntity,
    ]),
  ],
  controllers: [DiscussionBoardsController, DiscussionBoardAssetsController],
  providers: [DiscussionBoardsService],
  exports: [DiscussionBoardsService],
})
export class DiscussionBoardsModule {}
