import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Policy UX pass — adds document attachments to policies and an immutable
 * version-history table. Additive and reversible.
 */
export class PolicyVersionsAttachments1787820000000 implements MigrationInterface {
  name = 'PolicyVersionsAttachments1787820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "policies" ADD "attachments" jsonb`);

    await queryRunner.query(`
      CREATE TABLE "policy_versions" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "policy_id" character varying(24) NOT NULL,
        "organization_id" character varying(24) NOT NULL,
        "version" integer NOT NULL,
        "snapshot" jsonb NOT NULL,
        "changed_by" character varying(24),
        "change_summary" text,
        CONSTRAINT "PK_policy_version_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_policy_versions_policy_id" ON "policy_versions" ("policy_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_policy_version_policy" ON "policy_versions" ("policy_id", "version")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_policy_version_org" ON "policy_versions" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "policy_versions"`);
    await queryRunner.query(`ALTER TABLE "policies" DROP COLUMN "attachments"`);
  }
}
