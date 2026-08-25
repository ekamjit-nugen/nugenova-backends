import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner setup-wizard progress on the organization: `onboarding_step` (0 = not
 * started, 1..5 = current step) and `onboarding_completed`. Workspace config the
 * wizard collects (industry, size, timezone, currency, work culture, …) lives in
 * the existing `settings` jsonb — no schema change needed for it.
 */
export class OrgOnboarding1787740000000 implements MigrationInterface {
  name = 'OrgOnboarding1787740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "onboarding_step" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "onboarding_completed" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN "onboarding_completed"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN "onboarding_step"`,
    );
  }
}
