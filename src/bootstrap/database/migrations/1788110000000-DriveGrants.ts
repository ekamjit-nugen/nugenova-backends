import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Internal share grants — give another org member view/download/edit access to a
 * file or folder without a public link. Powers the "Shared with me" surface and
 * authorizes non-owner access on the authenticated file endpoints.
 */
export class DriveGrants1788110000000 implements MigrationInterface {
  name = 'DriveGrants1788110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "drive_grants" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "target_type" character varying NOT NULL,
        "target_id" character varying(24) NOT NULL,
        "scope" character varying NOT NULL,
        "grantee_user_id" character varying(24) NOT NULL,
        "permission" character varying NOT NULL DEFAULT 'view',
        "granted_by" character varying(24) NOT NULL,
        "granted_by_name" character varying,
        CONSTRAINT "PK_drive_grants" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_drive_grant" ON "drive_grants" ("organization_id", "target_type", "target_id", "grantee_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_drive_grant_grantee" ON "drive_grants" ("organization_id", "grantee_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_drive_grant_grantee"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ux_drive_grant"`);
    await queryRunner.query(`DROP TABLE "drive_grants"`);
  }
}
