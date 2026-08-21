import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';

/**
 * Minimal structural view of a Mongo Db handle — just the read ops the ETL
 * needs. Avoids a hard dependency on the `mongodb` package's types (mongoose
 * bundles the driver but doesn't re-export its types at the top level).
 */
export interface MongoDbLike {
  collection(name: string): {
    find(filter: Record<string, unknown>): { toArray(): Promise<any[]> };
    aggregate(pipeline: any[]): { toArray(): Promise<any[]> };
    countDocuments(filter?: Record<string, unknown>): Promise<number>;
  };
}

/**
 * Reusable Mongo→Postgres backfill harness for the hybrid migration.
 *
 * One `migrateCollection()` call copies a whole Mongo collection into its
 * Postgres table: read every doc (INCLUDING soft-deleted, to preserve history),
 * map each to entity columns, and bulk-UPSERT by primary key so the run is
 * IDEMPOTENT — safe to re-run to catch drift right before cutover.
 *
 * Ids are preserved verbatim: Mongo `_id` (ObjectId) → `id` (24-hex string), so
 * every cross-reference (stageId, accountId, assignedTo, …) keeps resolving with
 * no remapping. Original createdAt/updatedAt are carried over explicitly.
 *
 * This is the template every later module's ETL copies.
 */

export interface MigrateResult {
  collection: string;
  mongoCount: number;
  pgCount: number;
  inserted: number;
}

export async function migrateCollection<E extends ObjectLiteral>(
  mongo: MongoDbLike,
  ds: DataSource,
  opts: {
    /** Mongo collection name (e.g. 'leads'). */
    collection: string;
    /** Target TypeORM entity. */
    entity: EntityTarget<E>;
    /** Map one raw Mongo doc → a partial entity (column values). */
    map: (doc: any) => Partial<E>;
    /**
     * Mongo query to select the docs that belong to THIS module. Needed because
     * several collection names are shared across modules in the single physical
     * DB (e.g. `activities` holds both sales lead/deal activities AND another
     * module's sprint activities). Defaults to all docs.
     */
    filter?: Record<string, unknown>;
    /** Upsert batch size. */
    batchSize?: number;
  },
): Promise<MigrateResult> {
  const { collection, entity, map, filter = {}, batchSize = 500 } = opts;
  const repo = ds.getRepository(entity);
  const docs = await mongo.collection(collection).find(filter).toArray();

  let inserted = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    const rows = docs.slice(i, i + batchSize).map(map);
    if (!rows.length) continue;
    // INSERT ... ON CONFLICT (id) DO UPDATE — idempotent by primary key.
    await repo
      .createQueryBuilder()
      .insert()
      .values(rows as any)
      .orUpdate(
        // Overwrite every non-id column on conflict.
        repo.metadata.columns.map((c) => c.databaseName).filter((n) => n !== 'id'),
        ['id'],
      )
      .execute();
    inserted += rows.length;
  }

  const pgCount = await repo.count();
  return { collection, mongoCount: docs.length, pgCount, inserted };
}

/** Pretty-print a parity table for a set of migrate results. */
export function printParity(results: MigrateResult[]): void {
  console.log('\n  collection        mongo     pg   match');
  console.log('  ────────────────────────────────────────');
  for (const r of results) {
    const match = r.mongoCount === r.pgCount ? 'OK' : 'MISMATCH ⚠';
    console.log(
      `  ${r.collection.padEnd(16)} ${String(r.mongoCount).padStart(5)}  ${String(
        r.pgCount,
      ).padStart(5)}   ${match}`,
    );
  }
  console.log('');
}
