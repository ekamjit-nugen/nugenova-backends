import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Roles gain `tier` + `is_system`. This lets the standard tiers
 * (owner/admin/manager/employee/member/viewer) become REAL, visible role rows
 * seeded per org, so a member's tier is derived from their assigned role rather
 * than hardcoded on the membership. Owner/Admin carry a full-access `*` matrix.
 *
 * Schema-only; per-org seeding of the system roles + linking existing
 * memberships to them is done by the app (org-role seeding at creation, plus a
 * one-off backfill for pre-existing orgs).
 */
export class RoleTierSystem1787830000000 implements MigrationInterface {
  name = 'RoleTierSystem1787830000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "tier" varchar(24)`);
    await q.query(
      `ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "roles" DROP COLUMN IF EXISTS "is_system"`);
    await q.query(`ALTER TABLE "roles" DROP COLUMN IF EXISTS "tier"`);
  }
}
