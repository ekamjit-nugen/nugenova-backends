import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activity feed — a curated, org-scoped log of what members do (login, leave,
 * meetings, files, AI use, …) plus a per-org retention marker used by the
 * 15-day archive+purge job.
 */
export class Activity1788220000000 implements MigrationInterface {
  name = 'Activity1788220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "activity_events" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "actor_id" character varying(24),
        "actor_name" character varying,
        "action" character varying NOT NULL,
        "category" character varying NOT NULL DEFAULT 'other',
        "target_type" character varying,
        "target_id" character varying(24),
        "summary" character varying,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "ip" character varying,
        CONSTRAINT "pk_activity_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_activity_org_created" ON "activity_events" ("organization_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "ix_activity_org_actor_created" ON "activity_events" ("organization_id", "actor_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "ix_activity_org_category_created" ON "activity_events" ("organization_id", "category", "created_at")`);

    await queryRunner.query(`
      CREATE TABLE "activity_retention_runs" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "last_run_at" TIMESTAMP WITH TIME ZONE,
        "locked_at" TIMESTAMP WITH TIME ZONE,
        "last_archived_count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "pk_activity_retention_runs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_activity_retention_org" ON "activity_retention_runs" ("organization_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_activity_retention_org"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "activity_retention_runs"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_activity_org_category_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_activity_org_actor_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_activity_org_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "activity_events"`);
  }
}
