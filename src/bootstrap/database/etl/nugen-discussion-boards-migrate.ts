/* eslint-disable no-console */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { MongoClient } from 'mongodb';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { DiscussionBoardEntity } from '../../../modules/discussion-boards/entities/discussion-board.entity';
import { BoardNoteEntity } from '../../../modules/discussion-boards/entities/board-note.entity';
import { BoardNodeEntity } from '../../../modules/discussion-boards/entities/board-node.entity';
import { BoardCommentEntity } from '../../../modules/discussion-boards/entities/board-comment.entity';

/**
 * Nugen IT Services — legacy Mongo discussion boards (the "communication board")
 * → Postgres. Scoped to ONE legacy org → ONE target org; `_id` preserved so
 * child `boardId`/`noteId` references keep resolving; idempotent (orUpdate on id).
 * Only `organizationId` is rewritten. Board FKs already point at auth user ids —
 * no employeeId→userId remap.
 *
 * Migrates: discussionboards, boardnotes, boardnodes, boardcomments. (The 3,756
 * `boardnotehistories` audit rows and the S3 `boardassets`/`boardattachments`
 * are deferred to a later pass.)
 *
 * Run (dry-run):  DRY_RUN=1 SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/nugen-discussion-boards-migrate.ts
 * Run (execute):            SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/nugen-discussion-boards-migrate.ts
 */

const LEGACY_ORG = '6600000000000000000000a0';
const TARGET_ORG = '6a9fbcc377bf257f21e4b402';
const MONGO_DB = 'nugenova';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const sid = (v: unknown): string | null => (v == null ? null : String(v));
const dt = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n == null ? null : Math.trunc(n);
};
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (v == null ? null : String(v));

async function main() {
  const uri = process.env.SRC_MONGODB_URI;
  if (!uri) throw new Error('SRC_MONGODB_URI not set');
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

  const mc = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await mc.connect();
  const mdb = mc.db(MONGO_DB);
  const col = (n: string): any => mdb.collection(n);

  const ds = new DataSource({
    type: 'postgres',
    url: dbUrl,
    ssl: dbUrl && !isLocal ? { rejectUnauthorized: false } : false,
    entities: [DiscussionBoardEntity, BoardNoteEntity, BoardNodeEntity, BoardCommentEntity],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  if (!DRY_RUN) await ds.initialize();

  const report: Array<{ step: string; mongo: number; wrote: number; skipped?: number }> = [];
  const log = (step: string, mongo: number, wrote: number, skipped = 0) => {
    report.push({ step, mongo, wrote, skipped });
    console.log(`  ${step.padEnd(18)} mongo=${String(mongo).padStart(5)}  ${DRY_RUN ? 'would-write' : 'wrote'}=${String(wrote).padStart(5)}  skipped=${skipped}`);
  };

  const upsertAll = async (Entity: any, rows: any[]) => {
    if (DRY_RUN || !rows.length) return;
    const repo = ds.getRepository(Entity);
    const cols = repo.metadata.columns.map((c: any) => c.databaseName).filter((n: string) => n !== 'id');
    for (let i = 0; i < rows.length; i += 500) {
      await repo.createQueryBuilder().insert().values(rows.slice(i, i + 500)).orUpdate(cols, ['id']).execute();
    }
  };

  console.log(`\n=== discussion boards migration ${DRY_RUN ? '(DRY RUN — no writes)' : ''} ===`);
  console.log(`  legacy org ${LEGACY_ORG} → target org ${TARGET_ORG}\n`);

  // ── boards ──
  const boardDocs = await col('discussionboards').find({ organizationId: LEGACY_ORG }).toArray();
  const boardRows = boardDocs.map((b: any) => ({
    id: sid(b._id)!,
    organizationId: TARGET_ORG,
    title: String(b.title ?? 'Untitled board'),
    description: str(b.description),
    template: str(b.template),
    background: str(b.background),
    createdBy: sid(b.createdBy),
    createdByName: str(b.createdByName),
    participants: arr(b.participants),
    lanes: arr(b.lanes),
    driveExport: obj(b.driveExport),
    isArchived: bool(b.isArchived),
    isDeleted: bool(b.isDeleted),
    createdAt: dt(b.createdAt) ?? new Date(),
    updatedAt: dt(b.updatedAt) ?? new Date(),
  }));
  const boardIds = new Set(boardRows.map((r) => r.id));
  await upsertAll(DiscussionBoardEntity, boardRows);
  log('discussion_boards', boardDocs.length, boardRows.length);

  const childOf = (d: any) => d.boardId != null && boardIds.has(String(d.boardId));

  // ── notes ──
  const noteDocs = (await col('boardnotes').find({}).toArray()).filter(childOf);
  const noteRows = noteDocs.map((n: any) => ({
    id: sid(n._id)!,
    organizationId: TARGET_ORG,
    boardId: sid(n.boardId)!,
    authorId: sid(n.authorId),
    authorName: str(n.authorName),
    text: str(n.text),
    title: str(n.title),
    color: str(n.color),
    x: numOrNull(n.x),
    y: numOrNull(n.y),
    width: numOrNull(n.width),
    height: numOrNull(n.height),
    zIndex: intOrNull(n.zIndex),
    isDeleted: bool(n.isDeleted),
    createdAt: dt(n.createdAt) ?? new Date(),
    updatedAt: dt(n.updatedAt) ?? new Date(),
  }));
  await upsertAll(BoardNoteEntity, noteRows);
  log('board_notes', noteDocs.length, noteRows.length);

  // ── nodes ──
  const nodeDocs = (await col('boardnodes').find({}).toArray()).filter(childOf);
  const nodeRows = nodeDocs.map((n: any) => ({
    id: sid(n._id)!,
    organizationId: TARGET_ORG,
    boardId: sid(n.boardId)!,
    authorId: sid(n.authorId),
    authorName: str(n.authorName),
    nodeKind: str(n.nodeKind),
    label: str(n.label),
    x: numOrNull(n.x),
    y: numOrNull(n.y),
    width: numOrNull(n.width),
    height: numOrNull(n.height),
    fill: str(n.fill),
    stroke: str(n.stroke),
    zIndex: intOrNull(n.zIndex),
    isDeleted: bool(n.isDeleted),
    createdAt: dt(n.createdAt) ?? new Date(),
    updatedAt: dt(n.updatedAt) ?? new Date(),
  }));
  await upsertAll(BoardNodeEntity, nodeRows);
  log('board_nodes', nodeDocs.length, nodeRows.length);

  // ── comments ──
  const commentDocs = (await col('boardcomments').find({}).toArray()).filter(childOf);
  const commentRows = commentDocs.map((c: any) => ({
    id: sid(c._id)!,
    organizationId: TARGET_ORG,
    boardId: sid(c.boardId)!,
    noteId: sid(c.noteId),
    authorId: sid(c.authorId),
    authorName: str(c.authorName),
    text: str(c.text),
    isDeleted: bool(c.isDeleted),
    createdAt: dt(c.createdAt) ?? new Date(),
    updatedAt: dt(c.updatedAt) ?? new Date(),
  }));
  await upsertAll(BoardCommentEntity, commentRows);
  log('board_comments', commentDocs.length, commentRows.length);

  console.log(`\n=== ${DRY_RUN ? 'dry run' : 'migration'} complete ===`);
  console.table(report);
  if (!DRY_RUN) await ds.destroy();
  await mc.close();
}

main().catch((e) => {
  console.error('DISCUSSION BOARDS MIGRATION FAILED:', e);
  process.exit(1);
});
