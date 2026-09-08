import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vertical pack — §04/§12. Adds the two columns that turn the SAME platform into
 * a school/college/coaching tenant by CONFIG rather than a fork:
 *
 *  - `org_type` — company | school | college | coaching. Defaults to 'company'
 *    so EVERY existing organization is unchanged and keeps behaving exactly as
 *    before (the guardrail: additive, backfilled by the default).
 *  - `vertical_pack` — jsonb overrides on top of the orgType's default pack
 *    ({ vocabulary, enabledModules, aiTierCeiling }); null = use the default.
 *
 * Both live on `organizations`; the resolver (`VerticalPackService`) merges the
 * override over the code-side default packs.
 */
export class VerticalPack1788033000000 implements MigrationInterface {
  name = 'VerticalPack1788033000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "org_type" character varying(16) NOT NULL DEFAULT 'company'`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "vertical_pack" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "vertical_pack"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "org_type"`,
    );
  }
}
