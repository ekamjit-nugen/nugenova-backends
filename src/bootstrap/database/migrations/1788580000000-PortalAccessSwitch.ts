import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A master switch per client and per vendor: only when it is on can anyone at
 * that company sign in to their portal.
 *
 * New companies start closed — giving an outside company a login should be a
 * deliberate act. Companies that ALREADY have portal users are switched on by
 * the backfill below, so nobody who can sign in today is locked out by this
 * change.
 */
export class PortalAccessSwitch1788580000000 implements MigrationInterface {
  name = 'PortalAccessSwitch1788580000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "portal_enabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "portal_enabled" boolean NOT NULL DEFAULT false`);

    await queryRunner.query(`
      UPDATE "clients" c SET "portal_enabled" = true
      WHERE EXISTS (
        SELECT 1 FROM "org_memberships" m
        WHERE m."client_id" = c."id" AND m."role" = 'client' AND m."status" = 'active'
      )
    `);
    await queryRunner.query(`
      UPDATE "vendors" v SET "portal_enabled" = true
      WHERE EXISTS (
        SELECT 1 FROM "org_memberships" m
        WHERE m."vendor_id" = v."id" AND m."role" = 'vendor' AND m."status" = 'active'
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vendors" DROP COLUMN IF EXISTS "portal_enabled"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "portal_enabled"`);
  }
}
