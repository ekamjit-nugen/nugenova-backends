import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { KnowledgeChunkEntity, KnowledgeSourceType } from './entities/knowledge-chunk.entity';
import { DriveFileEntity } from '../storage/entities/drive-file.entity';
import { DocumentFileEntity } from '../../bootstrap/storage/document-file.entity';
import { StorageService } from '../../bootstrap/storage/storage.service';
import { chunkText } from './chunking';
import { extractText } from './text-extraction';

/** Outcome of indexing a single source document. */
export interface IndexOutcome {
  status: 'indexed' | 'skipped';
  sourceId: string;
  chunks: number;
  reason?: string;
}

/** Aggregate result of an org corpus (re)index. */
export interface ReindexResult {
  documents: number;
  chunks: number;
  skipped: number;
}

/** Indexed-corpus status for an org. */
export interface KnowledgeStatus {
  documents: number;
  chunks: number;
  lastIndexedAt: string | null;
}

/**
 * Builds and refreshes the org-visible FTS corpus.
 *
 * CORPUS SCOPE (privacy-critical): only ORG-VISIBLE documents are indexed —
 * Team-Drive files (`drive_files.scope = 'team'`), which already include the
 * bridged onboarding + group-chat-shared docs routed there by DriveService.
 * A private 'My Drive' (`scope = 'personal'`) file is NEVER indexed, so a user's
 * private document can never enter org-wide AI context. Everything is
 * `organizationId`-scoped end to end.
 */
@Injectable()
export class KnowledgeIngestionService {
  private readonly log = new Logger(KnowledgeIngestionService.name);

  constructor(
    @InjectRepository(KnowledgeChunkEntity)
    private readonly chunks: Repository<KnowledgeChunkEntity>,
    @InjectRepository(DriveFileEntity)
    private readonly driveFiles: Repository<DriveFileEntity>,
    @InjectRepository(DocumentFileEntity)
    private readonly documentFiles: Repository<DocumentFileEntity>,
    private readonly storage: StorageService,
  ) {}

  /**
   * (Re)index one source document into the org corpus: fetch its bytes, extract
   * text, chunk with overlap, then REPLACE the source's chunks (delete old rows,
   * insert fresh ones). `sourceRef` is a `drive_files.id` (preferred) or a
   * `document_files.id`. Enforces the corpus scope: a personal-scope drive file
   * is skipped, never indexed. Never throws on a bad/unextractable file — it
   * returns a `skipped` outcome the caller counts.
   */
  async indexDocument(organizationId: string, sourceRef: string): Promise<IndexOutcome> {
    const resolved = await this.resolveSource(organizationId, sourceRef);
    if (!resolved) {
      return { status: 'skipped', sourceId: sourceRef, chunks: 0, reason: 'source not found in org' };
    }
    if (resolved.excluded) {
      return { status: 'skipped', sourceId: sourceRef, chunks: 0, reason: resolved.excluded };
    }

    let buffer: Buffer;
    try {
      const meta = await this.storage.getMeta(resolved.storageFileId);
      buffer = await this.storage.getBytes(meta);
    } catch (err) {
      return {
        status: 'skipped',
        sourceId: resolved.sourceId,
        chunks: 0,
        reason: `bytes unavailable: ${(err as Error)?.message}`,
      };
    }

    const extracted = await extractText(buffer, resolved.sourceName, resolved.mimeType);
    if (extracted.status !== 'ok') {
      return { status: 'skipped', sourceId: resolved.sourceId, chunks: 0, reason: extracted.reason };
    }

    const pieces = chunkText(extracted.text);
    if (pieces.length === 0) {
      return { status: 'skipped', sourceId: resolved.sourceId, chunks: 0, reason: 'no chunks produced' };
    }

    await this.replaceChunks(
      organizationId,
      resolved.sourceType,
      resolved.sourceId,
      resolved.sourceName,
      pieces,
    );
    return { status: 'indexed', sourceId: resolved.sourceId, chunks: pieces.length };
  }

  /**
   * (Re)index the org's entire visible corpus: every Team-Drive file. Idempotent
   * — safe to re-run. Prunes chunks for any source no longer in the visible set
   * (e.g. a deleted/removed file), so the corpus never serves stale content.
   */
  async reindexOrg(organizationId: string): Promise<ReindexResult> {
    const teamFiles = await this.driveFiles.find({
      where: { organizationId, scope: 'team', isDeleted: false },
    });

    let documents = 0;
    let chunks = 0;
    let skipped = 0;
    const keptSourceIds: string[] = [];

    for (const file of teamFiles) {
      const outcome = await this.indexDocument(organizationId, file.id);
      if (outcome.status === 'indexed') {
        documents++;
        chunks += outcome.chunks;
        keptSourceIds.push(outcome.sourceId);
      } else {
        skipped++;
      }
    }

    await this.pruneExcept(organizationId, keptSourceIds);

    this.log.log(
      `reindexOrg(${organizationId}): documents=${documents} chunks=${chunks} skipped=${skipped}`,
    );
    return { documents, chunks, skipped };
  }

  /** Indexed-corpus counts + last index time for an org (admin status view). */
  async getStatus(organizationId: string): Promise<KnowledgeStatus> {
    const row = await this.chunks
      .createQueryBuilder('c')
      .select('COUNT(DISTINCT c.source_id)', 'documents')
      .addSelect('COUNT(c.id)', 'chunks')
      .addSelect('MAX(c.created_at)', 'last')
      .where('c.organization_id = :organizationId', { organizationId })
      .getRawOne<{ documents: string; chunks: string; last: Date | string | null }>();

    const last = row?.last ? new Date(row.last).toISOString() : null;
    return {
      documents: Number(row?.documents || 0),
      chunks: Number(row?.chunks || 0),
      lastIndexedAt: last,
    };
  }

  // ── internals ────────────────────────────────────────────────────

  /**
   * Resolve a source ref to the bytes handle + display metadata, enforcing the
   * corpus scope. Returns `excluded` (a reason string) for a private-scope drive
   * file so it is skipped rather than indexed; `null` when nothing matches in
   * this org.
   */
  private async resolveSource(
    organizationId: string,
    sourceRef: string,
  ): Promise<{
    sourceType: KnowledgeSourceType;
    sourceId: string;
    sourceName: string;
    storageFileId: string;
    mimeType: string;
    excluded?: string;
  } | null> {
    const drive = await this.driveFiles.findOne({
      where: { id: sourceRef, organizationId, isDeleted: false },
    });
    if (drive) {
      // PRIVACY: never index a user's private 'My Drive' file into org context.
      if (drive.scope !== 'team') {
        return {
          sourceType: 'drive_file',
          sourceId: drive.id,
          sourceName: drive.name,
          storageFileId: drive.storageFileId,
          mimeType: drive.mimeType,
          excluded: 'personal-scope (My Drive) file excluded from org corpus',
        };
      }
      return {
        sourceType: 'drive_file',
        sourceId: drive.id,
        sourceName: drive.name,
        storageFileId: drive.storageFileId,
        mimeType: drive.mimeType,
      };
    }

    const doc = await this.documentFiles.findOne({
      where: { id: sourceRef, organizationId, isDeleted: false },
    });
    if (doc) {
      return {
        sourceType: 'document_file',
        sourceId: doc.id,
        sourceName: doc.originalName,
        storageFileId: doc.id, // document_files IS the byte store row
        mimeType: doc.mimeType,
      };
    }

    return null;
  }

  /** Replace a source's chunks atomically-ish: delete old rows, insert fresh. */
  private async replaceChunks(
    organizationId: string,
    sourceType: KnowledgeSourceType,
    sourceId: string,
    sourceName: string,
    pieces: string[],
  ): Promise<void> {
    await this.chunks.delete({ organizationId, sourceId });
    const rows = pieces.map((content, chunkIndex) =>
      this.chunks.create({
        organizationId,
        sourceType,
        sourceId,
        sourceName,
        chunkIndex,
        content,
      }),
    );
    await this.chunks.save(rows);
  }

  /** Drop chunks for any source id not in the current visible set. */
  private async pruneExcept(organizationId: string, keepSourceIds: string[]): Promise<void> {
    const qb = this.chunks
      .createQueryBuilder()
      .delete()
      .where('organization_id = :organizationId', { organizationId });
    if (keepSourceIds.length) {
      qb.andWhere('source_id NOT IN (:...keepSourceIds)', { keepSourceIds });
    }
    await qb.execute();
  }
}
