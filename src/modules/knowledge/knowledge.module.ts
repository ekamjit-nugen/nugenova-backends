import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { DriveFileEntity } from '../storage/entities/drive-file.entity';
import { DocumentFileEntity } from '../../bootstrap/storage/document-file.entity';

import { KnowledgeChunkEntity } from './entities/knowledge-chunk.entity';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { KnowledgeQaService } from './knowledge-qa.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeAdminGuard } from './knowledge-admin.guard';

/**
 * Knowledge — org-level document retrieval (RAG) over Postgres full-text search.
 *
 * Indexes the ORG-VISIBLE corpus (Team-Drive files + bridged onboarding/chat
 * docs; never private 'My Drive' files) into `knowledge_chunks`, retrieves
 * org-scoped context by FTS rank, and answers `/ai/ask` THROUGH
 * {@link AiService.complete} (feature `org_qa`) so every answer inherits the AI
 * runtime's tier/consent/usage policy gate + metering.
 *
 * Byte access is via the shared global `StorageService` (StorageModule is
 * @Global). Reads `drive_files` + `document_files` read-only to resolve sources.
 */
@Module({
  imports: [
    AuthModule, // JwtAuthGuard machinery (JwtService + TokenRevocationService)
    AiModule, // AiService.complete — the gated + metered completion path
    TypeOrmModule.forFeature([
      KnowledgeChunkEntity,
      DriveFileEntity, // read-only: the Team-Drive source set
      DocumentFileEntity, // read-only: resolve a document_files source directly
    ]),
  ],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeIngestionService,
    KnowledgeRetrievalService,
    KnowledgeQaService,
    KnowledgeAdminGuard,
  ],
  exports: [KnowledgeIngestionService, KnowledgeRetrievalService],
})
export class KnowledgeModule {}
