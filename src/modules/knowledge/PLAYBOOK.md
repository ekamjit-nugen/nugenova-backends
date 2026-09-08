# Knowledge — org document retrieval (RAG) over Postgres FTS

Org-level Retrieval-Augmented Generation. Indexes the **org-visible** document
corpus into `knowledge_chunks`, retrieves org-scoped context by Postgres
full-text search, and answers `POST /ai/ask` **through** `AiService.complete`
(feature `org_qa`) so every answer inherits the AI runtime's tier / consent /
usage policy gate **and** its metering.

## HTTP surface (`/api/v1/ai/*`, JWT-guarded, org from `req.user`)

| Method + path              | Guard                       | Body / result |
|----------------------------|-----------------------------|---------------|
| `POST /ai/ask`             | JWT (any org member)        | `{ question, topK? }` → `{ answer, sources:[{sourceId,sourceName,chunkIndex}], grounded }` |
| `POST /ai/knowledge/reindex` | JWT + `KnowledgeAdminGuard` (owner/admin/platform-admin) | → `{ documents, chunks, skipped }` |
| `GET  /ai/knowledge/status`  | JWT + `KnowledgeAdminGuard` | → `{ documents, chunks, lastIndexedAt }` |

The acting org is **always** the JWT's own `organizationId`, never the body — a
token for org A can neither index nor query org B.

## Corpus scope (privacy-critical)

Indexed = **org-visible** documents only:

- **Team-Drive files** — `drive_files` where `scope = 'team'` and not deleted.
  This set already includes the **bridged onboarding + group-chat-shared** docs,
  because `DriveService` routes those into Team Drive (see storage/PLAYBOOK).
- A `document_files` row may also be indexed directly by id (sourceType
  `document_file`) — used when a caller has a raw stored-doc id rather than a
  drive row.

**Excluded — never indexed into org context:**

- **Private 'My Drive' files** (`drive_files.scope = 'personal'`). A DM chat
  attachment is bridged to each participant's *personal* drive, so it too stays
  out. `KnowledgeIngestionService.resolveSource` hard-rejects a personal-scope
  drive file with an `excluded` reason, so even a direct `indexDocument(orgId,
  personalFileId)` call skips it rather than leaking it.

**Tenant isolation.** Every chunk carries `organizationId`; every retrieval and
status read filters by it. In `KnowledgeRetrievalService.search`,
`organization_id = $1` is the **first bound parameter** of the ranked SQL, so a
search can only ever match the caller's own org — another tenant's chunk is
unreachable. Proven by an explicit cross-org test
(`knowledge-retrieval.service.spec.ts`) and validated at the SQL level.

## Full-text search + ranking

`knowledge_chunks.search_vector` is a **STORED generated** `tsvector`:

```sql
search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
```

backed by a **GIN** index (`ix_knowledge_chunks_search_vector`). It is
DB-managed — the app never writes it (mapped `insert:false/update:false/
select:false` on the entity).

Retrieval ranks with:

```sql
ts_rank_cd(search_vector, plainto_tsquery('english', $2))
```

filtered by `search_vector @@ plainto_tsquery(...)`, ordered by rank desc, top-K
(default 6, clamped 1–20). Empty / <2-char queries short-circuit to `[]` (no
query ⇒ no leak). English config + `plainto_tsquery` give stemming and stop-word
handling for free with zero dependencies.

Other indexes: btree on `organization_id` (tenant scoping) and a UNIQUE
`(organization_id, source_id, chunk_index)` that makes re-indexing a source
idempotent.

## Chunking

`chunking.ts` splits normalized text into ~500–800-token passages, approximated
as **~2400 chars with ~15% (360-char) overlap** (no tokenizer dependency).
Both chunk **end** and the overlapped **start** snap to whitespace so words are
never cut. Overlap guarantees a fact on a boundary survives whole in a chunk.
Re-indexing a source **replaces** its rows (delete-then-insert), never
duplicates.

## Extraction coverage

`text-extraction.ts`, by mime/extension, never throws (returns a status the
indexer records as a skip):

| Type | Handling |
|------|----------|
| txt / md / json / csv / tsv / yaml / log / `text/*` | native UTF-8 decode (no dep) |
| **PDF** | `pdf-parse` (added dependency), lazy-required |
| **xlsx / docx / ppt / odf** | **NOT extracted — `unextractable` seam** (below) |
| empty / oversized (>20 MB) / binary (NUL / control-heavy) | skipped gracefully |

### Seam: office extraction (xlsx / docx)

Office formats are reported `unextractable` today. Adding them is a
single-function change in `text-extraction.ts` (e.g. a lightweight `mammoth`
for docx, `xlsx`/`exceljs` for spreadsheets) — no call-site or schema change.
The indexer already counts these as `skipped`, so wiring a lib in only *adds*
coverage.

## Seam: live indexing on upload

Today the corpus is (re)built by the **backfill** endpoint
(`POST /ai/knowledge/reindex`). To index new/updated files as they land, hook
the same in-process bus the drive already uses:

- Drive/chat files flow through `DriveChatBridge` / `DriveService` on the
  `EventEmitter2` bus (e.g. `CHAT_MESSAGE_NEW`). A thin `@OnEvent` listener (or a
  direct `indexDocument(orgId, driveFileId)` call from `DriveService.uploadFile`
  once a file lands in Team Drive) would keep the index warm.
- Keep it fire-and-forget and scope-checked (`indexDocument` already rejects
  personal-scope), so a private upload can never be indexed even via the hook.

Left as the backfill mechanism for this build; the hook is a clean, additive
follow-up.

## Seam: vector upgrade (pgvector)

The schema is **vector-ready** but pgvector is **not enabled** now (no
`CREATE EXTENSION vector`). A future migration can:

1. `CREATE EXTENSION IF NOT EXISTS vector;`
2. `ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(N);` beside
   `search_vector`, plus an IVFFlat/HNSW index.
3. Populate embeddings during ingestion and blend semantic + FTS scores (hybrid
   retrieval) in `KnowledgeRetrievalService`.

The entity documents this reservation; nothing in the current FTS path needs to
change to add it.

## Files

- `entities/knowledge-chunk.entity.ts` — `knowledge_chunks` (+ generated tsvector)
- `../../bootstrap/database/migrations/1788130000000-KnowledgeChunks.ts`
- `chunking.ts`, `text-extraction.ts`
- `knowledge-ingestion.service.ts` — `indexDocument` / `reindexOrg` / `getStatus`
- `knowledge-retrieval.service.ts` — org-scoped `search`
- `knowledge-qa.service.ts` — assemble context + `AiService.complete` (`org_qa`)
- `knowledge.controller.ts`, `knowledge-admin.guard.ts`, `dto/`
- Specs: `*.spec.ts` (chunking, retrieval cross-org isolation, ingestion
  replace/exclusion, QA `org_qa` wiring)
