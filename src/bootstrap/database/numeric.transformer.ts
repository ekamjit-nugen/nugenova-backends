import { ValueTransformer } from 'typeorm';

/**
 * Postgres `numeric`/`decimal` columns are returned as STRINGS by the pg driver
 * (to avoid precision loss on huge values). Our money fields were plain JS
 * numbers under Mongo, and the analytics SUMs + API responses expect numbers —
 * so hydrate numeric columns back to `number` on read.
 *
 * Safe for money magnitudes (well within IEEE-754 exact-integer range at 2dp);
 * apply per-column via `@Column({ transformer: numericTransformer })`.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null | undefined =>
    value === null || value === undefined ? (value as null | undefined) : parseFloat(value),
};
