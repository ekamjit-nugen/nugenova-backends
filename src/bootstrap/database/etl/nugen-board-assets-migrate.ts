/* eslint-disable no-console */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { MongoClient } from 'mongodb';
import { Client as Pg } from 'pg';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

/**
 * Migrate legacy discussion-board image assets (`boardassets`) so notes' embedded
 * images render in the new app. Legacy notes reference `/discussion-board/img/<token>`;
 * the bytes live in the shared S3 bucket at that key. We create a `document_files`
 * row (category `board-asset`) that POINTS AT the existing S3 object — no byte
 * copy — with the legacy `_id` preserved, then rewrite the note markdown/HTML to
 * `/discussion-boards/assets/<id>` (served publicly by the new endpoint).
 *
 * Run (dry-run):  DRY_RUN=1 SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/nugen-board-assets-migrate.ts
 * Run (execute):            SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/nugen-board-assets-migrate.ts
 */

const LEGACY_ORG = '6600000000000000000000a0';
const TARGET_ORG = '6a9fbcc377bf257f21e4b402';
const MONGO_DB = 'nugenova';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const extForMime = (m: string): string =>
  ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[(m || '').toLowerCase()] || 'bin');

async function main() {
  const uri = process.env.SRC_MONGODB_URI;
  if (!uri) throw new Error('SRC_MONGODB_URI not set');
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET not set');

  const s3 = new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
    forcePathStyle: !!process.env.S3_ENDPOINT && !/amazonaws\.com/.test(process.env.S3_ENDPOINT || ''),
  });

  const mc = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await mc.connect();
  const assets = await mc.db(MONGO_DB).collection('boardassets').find({ organizationId: LEGACY_ORG }).toArray();

  const pg = new Pg({ connectionString: dbUrl, ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false } });
  await pg.connect();

  let existing = 0, missing = 0, wrote = 0, rewrites = 0;
  for (const a of assets as any[]) {
    // Legacy S3 objects are prefixed with `orgs/<legacyOrg>/` (same layout as the
    // earlier document migration); the boardasset.storageKey is the suffix.
    const key = `orgs/${LEGACY_ORG}/${String(a.storageKey || `discussion-board/img/${a.token}`)}`;
    let ok = false;
    try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); ok = true; existing++; }
    catch { missing++; }
    if (!ok) continue;

    const id = String(a._id);
    const ext = extForMime(a.contentType);
    if (!DRY_RUN) {
      await pg.query(
        `INSERT INTO document_files (id, organization_id, uploaded_by, original_name, mime_type, size, driver, storage_key, content, category, is_deleted, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'s3',$7,NULL,'board-asset',false,$8,$9)
         ON CONFLICT (id) DO UPDATE SET storage_key=EXCLUDED.storage_key, mime_type=EXCLUDED.mime_type, category=EXCLUDED.category, is_deleted=false`,
        [id, TARGET_ORG, a.uploaderId ? String(a.uploaderId) : null, `${a.token}.${ext}`, String(a.contentType || 'image/png'), Number(a.size) || 0, key, a.createdAt ? new Date(a.createdAt) : new Date(), a.updatedAt ? new Date(a.updatedAt) : new Date()],
      );
      wrote++;
      // Rewrite note references: /discussion-board/img/<token> → /discussion-boards/assets/<id>
      const res = await pg.query(
        `UPDATE board_notes SET text = REPLACE(text, $1, $2)
         WHERE organization_id = $3 AND text LIKE $4`,
        [`discussion-board/img/${a.token}`, `discussion-boards/assets/${id}`, TARGET_ORG, `%discussion-board/img/${a.token}%`],
      );
      rewrites += res.rowCount || 0;
    }
  }

  // How many notes STILL reference the legacy path (unmatched tokens)?
  const leftover = (await pg.query(
    `SELECT count(*)::int n FROM board_notes WHERE organization_id=$1 AND text LIKE '%discussion-board/img/%'`,
    [TARGET_ORG],
  )).rows[0].n;

  console.log(`\n=== board assets migration ${DRY_RUN ? '(DRY RUN)' : ''} ===`);
  console.log(`  bucket=${bucket}`);
  console.table([{ step: 'boardassets', mongo: assets.length, s3Found: existing, s3Missing: missing, wrote, noteRewrites: rewrites }]);
  console.log(`  notes still referencing legacy /discussion-board/img/: ${leftover}`);

  await pg.end();
  await mc.close();
}

main().catch((e) => { console.error('BOARD ASSETS MIGRATION FAILED:', e); process.exit(1); });
