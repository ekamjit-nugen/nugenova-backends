import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A member's job title, per organization.
 *
 * `users.job_title` already existed but belongs to the PERSON, so it is shared
 * by every org they belong to and only they can edit it. A title is an
 * employment fact, not a personal one — the same person can be a Consultant in
 * one org and a Director in another — so it lives on the membership, where the
 * directory's `employees:edit` permission governs it.
 *
 * Existing data stays put: legacy designations were flattened into
 * `users.job_title` by the ETL, and the directory falls back to that until
 * someone sets an org title.
 */
export class MemberTitle1788480000000 implements MigrationInterface {
  name = 'MemberTitle1788480000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "org_memberships" ADD COLUMN IF NOT EXISTS "title" character varying(80)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "org_memberships" DROP COLUMN IF EXISTS "title"`);
  }
}
