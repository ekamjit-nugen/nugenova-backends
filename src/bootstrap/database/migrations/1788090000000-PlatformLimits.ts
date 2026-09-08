import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Super-admin control plane for per-org limits:
 *   - `platform_settings` — a single row of platform-wide DEFAULTS (default org
 *     storage GB, default per-user My-Drive GB, default seat cap) applied to new
 *     orgs and used as the fallback for any org with no explicit override.
 *   - `organizations.limits` jsonb — per-org seat cap override (`{ maxMembers }`).
 *
 * Storage allocation itself continues to live in `drive_quotas` (the physical
 * enforcement point); this migration only adds the DEFAULTS + the seat-cap field.
 * Additive and back-compatible: existing orgs get `limits = NULL` (inherit the
 * default), and the settings row is seeded with today's hardcoded defaults.
 */
export class PlatformLimits1788090000000 implements MigrationInterface {
  name = 'PlatformLimits1788090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "platform_settings" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "default_org_storage_gb" integer NOT NULL DEFAULT 50,
        "default_user_quota_gb" integer NOT NULL DEFAULT 1,
        "default_max_members" integer,
        "updated_by" character varying(24),
        CONSTRAINT "PK_platform_settings" PRIMARY KEY ("id")
      )
    `);
    // Seed the singleton row with the current hardcoded defaults.
    await queryRunner.query(
      `INSERT INTO "platform_settings" ("id", "default_org_storage_gb", "default_user_quota_gb", "default_max_members")
       VALUES ('000000000000000000000001', 50, 1, NULL)
       ON CONFLICT ("id") DO NOTHING`,
    );

    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN "limits" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "limits"`);
    await queryRunner.query(`DROP TABLE "platform_settings"`);
  }
}
