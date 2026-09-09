import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AttendanceModule } from '../attendance/attendance.module';

import { AiConversationEntity } from './entities/ai-conversation.entity';
import { AiMessageEntity } from './entities/ai-message.entity';
import { AiJobEntity } from './entities/ai-job.entity';
import { AiJobService } from './services/ai-job.service';
import { AiChatService } from './services/ai-chat.service';
import { AiChatController } from './ai-chat.controller';

/**
 * AI chatbot — async, RAG-grounded, multi-turn conversations.
 *
 * Sits on top of the existing AI runtime and knowledge RAG:
 *   - {@link AiModule} supplies {@link AiService}.complete (the gated + metered
 *     completion path; this module tags every call `feature: 'chatbot'`),
 *   - {@link KnowledgeModule} supplies KnowledgeRetrievalService (org-scoped FTS
 *     for grounding — reused, not reimplemented),
 *   - {@link AuthModule} supplies the JwtAuthGuard machinery.
 *
 * ASYNC MODEL: RunPod cold-starts can take ~90s, so the LLM call must not block
 * the HTTP request. {@link AiJobService} runs the work IN-PROCESS off the request
 * path (DB job row + `setImmediate`, no Redis/BullMQ); the client polls
 * `GET /ai/chat/messages/:id` for the result. See PLAYBOOK.md for the full async
 * model, poll contract, grounding, and the process-restart orphan-job seam.
 *
 * JWT-guarded, org+user-scoped (`req.user` only): a user sees only their own
 * conversations.
 */
@Module({
  imports: [
    AuthModule,
    AiModule,
    KnowledgeModule,
    AttendanceModule,
    TypeOrmModule.forFeature([AiConversationEntity, AiMessageEntity, AiJobEntity]),
  ],
  controllers: [AiChatController],
  providers: [AiJobService, AiChatService],
  exports: [AiChatService, AiJobService],
})
export class AiChatModule {}
