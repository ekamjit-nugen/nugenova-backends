/* eslint-disable no-console */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { MongoClient } from 'mongodb';
import { Client as Pg } from 'pg';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * Bring the legacy files that the earlier ETLs left behind into the new app.
 *
 * The bytes are already in our own bucket (the legacy objects were copied under
 * `orgs/<legacyOrg>/`); what is missing are the Postgres rows, which is why the
 * files are invisible in the new app. Like the board-asset migration, nothing is
 * copied byte-for-byte here except avatars, which still live in the OLD public
 * bucket and would break the day it goes away.
 *
 * Parts (run one, several or all — `PARTS=drive,avatars`, default `drive`):
 *
 *   drive    `storagefolders` → `drive_folders`, `storagefiles` → `document_files`
 *            (category `drive`) + `drive_files` pointing at it. Legacy ids are kept,
 *            so a re-run updates the same rows instead of duplicating them.
 *   avatars  Copies each user's legacy-bucket avatar into our bucket and records a
 *            `document_files` row (category `avatar`). `users.avatar` is NOT
 *            rewritten: there is no route yet that serves an avatar by file id, so
 *            rewriting would blank every profile picture. This part only makes us
 *            independent of the old bucket.
 *
 * Chat attachments (`mediafiles`, 41 files) are deliberately NOT handled: the legacy
 * conversations and messages were never migrated, so the files would have nothing to
 * hang off. Migrate chat history first, then extend this script.
 *
 * Run (dry-run):  DRY_RUN=1 SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/nugen-files-migrate.ts
 * Run (execute):            SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/nugen-files-migrate.ts
 */

const LEGACY_ORG = '6600000000000000000000a0';
const TARGET_ORG = '6a9fbcc377bf257f21e4b402';
const MONGO_DB = 'nugenova';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const PARTS = (process.env.PARTS || 'drive').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);

/** Legacy avatars still point at the old public bucket. */
const LEGACY_AVATAR_HOST = 'nugen.s3.ap-south-1.amazonaws.com';

const extForMime = (m: string): string =>
  ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[
    (m || '').toLowerCase()
  ] || 'bin');

interface Counters {
  [k: string]: number;
}

const bump = (c: Counters, k: string, by = 1) => {
  c[k] = (c[k] || 0) + by;
};

async function migrateDrive(mongo: MongoClient, pg: Pg, s3: S3Client, bucket: string, counts: Counters) {
  const db = mongo.db(MONGO_DB);
  const folders = await db.collection('storagefolders').find({ organizationId: LEGACY_ORG, isDeleted: { $ne: true } }).toArray();
  const files = await db.collection('storagefiles').find({ organizationId: LEGACY_ORG, isDeleted: { $ne: true } }).toArray();

  // Folders first, so a file's folder_id always points at a row that exists.
  for (const f of folders as any[]) {
    bump(counts, 'folders.read');
    if (DRY_RUN) continue;
    await pg.query(
      `INSERT INTO drive_folders (id, organization_id, name, scope, owner_id, parent_folder_id, path, created_by, created_by_name, system_managed, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,false,$10,$11)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, scope=EXCLUDED.scope, owner_id=EXCLUDED.owner_id,
         parent_folder_id=EXCLUDED.parent_folder_id, path=EXCLUDED.path, is_deleted=false, updated_at=EXCLUDED.updated_at`,
      [
        String(f._id),
        TARGET_ORG,
        String(f.name || 'Untitled'),
        f.scope === 'personal' ? 'personal' : 'team',
        f.ownerUserId ? String(f.ownerUserId) : null,
        f.parentId ? String(f.parentId) : null,
        String(f.path || '/'),
        f.createdBy ? String(f.createdBy) : TARGET_ORG,
        f.createdByName ? String(f.createdByName) : null,
        f.createdAt ? new Date(f.createdAt) : new Date(),
        f.updatedAt ? new Date(f.updatedAt) : new Date(),
      ],
    );
    bump(counts, 'folders.written');
  }

  for (const f of files as any[]) {
    bump(counts, 'files.read');
    // Legacy objects live under `orgs/<legacyOrg>/` in our bucket (same layout the
    // board-asset migration used); `storageKey` is the suffix.
    const key = `orgs/${LEGACY_ORG}/${String(f.storageKey || '')}`;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      bump(counts, 'files.bytesMissing');
      console.warn(`  ! no object in S3 for "${f.name}" (${key}) — skipped`);
      continue;
    }
    bump(counts, 'files.bytesFound');
    if (DRY_RUN) continue;

    const id = String(f._id);
    const uploader = f.uploadedBy ? String(f.uploadedBy) : null;
    await pg.query(
      `INSERT INTO document_files (id, organization_id, uploaded_by, original_name, mime_type, size, driver, storage_key, content, category, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'s3',$7,NULL,'drive',false,$8,$9)
       ON CONFLICT (id) DO UPDATE SET storage_key=EXCLUDED.storage_key, mime_type=EXCLUDED.mime_type,
         original_name=EXCLUDED.original_name, size=EXCLUDED.size, category='drive', is_deleted=false`,
      [
        id,
        TARGET_ORG,
        uploader,
        String(f.name || 'Untitled'),
        String(f.contentType || 'application/octet-stream'),
        Number(f.sizeBytes) || 0,
        key,
        f.createdAt ? new Date(f.createdAt) : new Date(),
        f.updatedAt ? new Date(f.updatedAt) : new Date(),
      ],
    );
    await pg.query(
      `INSERT INTO drive_files (id, organization_id, name, size, mime_type, storage_file_id, scope, owner_id, folder_id, uploaded_by, uploaded_by_name, tags, system_managed, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,false,$13,$14)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, size=EXCLUDED.size, mime_type=EXCLUDED.mime_type,
         storage_file_id=EXCLUDED.storage_file_id, scope=EXCLUDED.scope, owner_id=EXCLUDED.owner_id,
         folder_id=EXCLUDED.folder_id, tags=EXCLUDED.tags, is_deleted=false, updated_at=EXCLUDED.updated_at`,
      [
        id,
        TARGET_ORG,
        String(f.name || 'Untitled'),
        Number(f.sizeBytes) || 0,
        String(f.contentType || 'application/octet-stream'),
        id, // the document_files row written just above
        f.scope === 'personal' ? 'personal' : 'team',
        f.ownerUserId ? String(f.ownerUserId) : null,
        f.folderId ? String(f.folderId) : null,
        uploader || TARGET_ORG,
        f.uploadedByName ? String(f.uploadedByName) : null,
        JSON.stringify(Array.isArray(f.tags) ? f.tags : []),
        f.createdAt ? new Date(f.createdAt) : new Date(),
        f.updatedAt ? new Date(f.updatedAt) : new Date(),
      ],
    );
    bump(counts, 'files.written');
  }

  // Uploaders/owners that no longer exist read as a blank name in the UI — worth knowing.
  const ids = [...new Set((files as any[]).map((f) => f.uploadedBy).filter(Boolean).map(String))];
  if (ids.length) {
    const res = await pg.query(`SELECT id FROM users WHERE id = ANY($1::varchar[])`, [ids]);
    bump(counts, 'files.uploadersKnown', res.rowCount || 0);
    bump(counts, 'files.uploadersUnknown', ids.length - (res.rowCount || 0));
  }
}

async function migrateAvatars(pg: Pg, s3: S3Client, bucket: string, counts: Counters) {
  const { rows } = await pg.query<{ id: string; avatar: string }>(
    `SELECT id, avatar FROM users WHERE avatar LIKE $1`,
    [`%${LEGACY_AVATAR_HOST}%`],
  );
  for (const u of rows) {
    bump(counts, 'avatars.read');
    if (DRY_RUN) continue;
    let body: Buffer;
    let mime = 'image/jpeg';
    try {
      const res = await fetch(u.avatar);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mime = res.headers.get('content-type') || mime;
      body = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      bump(counts, 'avatars.unreachable');
      console.warn(`  ! could not fetch avatar for user ${u.id}: ${(e as Error).message}`);
      continue;
    }
    const key = `orgs/${TARGET_ORG}/avatars/${u.id}.${extForMime(mime)}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mime }));
    await pg.query(
      `INSERT INTO document_files (id, organization_id, uploaded_by, original_name, mime_type, size, driver, storage_key, content, category, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'s3',$7,NULL,'avatar',false,now(),now())
       ON CONFLICT (id) DO UPDATE SET storage_key=EXCLUDED.storage_key, mime_type=EXCLUDED.mime_type, size=EXCLUDED.size, is_deleted=false`,
      [`avatar-${u.id}`.slice(0, 32), TARGET_ORG, u.id, `${u.id}.${extForMime(mime)}`, mime, body.length, key],
    );
    bump(counts, 'avatars.copied');
  }
}

async function main() {
  const uri = process.env.SRC_MONGODB_URI;
  if (!uri) throw new Error('SRC_MONGODB_URI not set');
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET not set');

  console.log(`${DRY_RUN ? 'DRY RUN' : 'EXECUTING'} — parts: ${PARTS.join(', ')}`);
  console.log(`legacy org ${LEGACY_ORG} → org ${TARGET_ORG}, bucket ${bucket}\n`);

  const s3 = new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
    forcePathStyle: !!process.env.S3_ENDPOINT && !/amazonaws\.com/.test(process.env.S3_ENDPOINT || ''),
  });

  const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await mongo.connect();
  const pg = new Pg({ connectionString: dbUrl, ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false } });
  await pg.connect();

  const counts: Counters = {};
  try {
    if (PARTS.includes('drive')) await migrateDrive(mongo, pg, s3, bucket, counts);
    if (PARTS.includes('avatars')) await migrateAvatars(pg, s3, bucket, counts);
  } finally {
    await mongo.close();
    await pg.end();
  }

  console.log(`\n${DRY_RUN ? 'Would migrate' : 'Migrated'}:`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(24)} ${v}`);
  if (DRY_RUN) console.log('\nNothing was written. Re-run without DRY_RUN=1 to apply.');
}

main().catch((e) => {
  console.error('ETL failed:', e);
  process.exit(1);
});
