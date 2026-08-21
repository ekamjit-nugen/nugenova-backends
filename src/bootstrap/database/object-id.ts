import { Types } from 'mongoose';

/**
 * Generate a fresh 24-char hex ObjectId string for a new Postgres row.
 *
 * The hybrid datastore keeps identifiers as 24-hex ObjectId strings on BOTH
 * engines so a Mongo document can reference a migrated Postgres row (and vice
 * versa) with no id remapping. New rows created on the Postgres side mint a
 * real ObjectId here — same format, same monotonic-ish timestamp prefix — so
 * ids stay uniform across the whole platform.
 *
 * (Uses Mongoose's bundled bson ObjectId — already a dependency — rather than
 * a DB-side default, so no pgcrypto extension is needed.)
 */
export function newObjectId(): string {
  return new Types.ObjectId().toHexString();
}
