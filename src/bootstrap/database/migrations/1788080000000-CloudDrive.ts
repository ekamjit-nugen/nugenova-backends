import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cloud Drive — the per-tenant file vault ported from the Mongo `storage`
 * module. Four additive, reversible tables (the Mongo monolith is untouched):
 *
 *  - `drive_folders`  — the folder tree (personal "My Drive" + shared "Team
 *    Drive", discriminated by `scope`). `parent_folder_id` is the source of
 *    truth; `path` is a materialized breadcrumb string.
 *  - `drive_files`    — file metadata. Bytes are delegated to the shared
 *    `document_files` store via `storage_file_id` (no second byte store).
 *  - `drive_shares`   — external share links (opaque token, optional password /
 *    expiry). PARTIAL-UNIQUE-free plain unique on `token`.
 *  - `drive_quotas`   — per-scope quota LIMITS (team pool + per-user overrides);
 *    USED bytes are always summed live from `drive_files`.
 *
 * Index choices mirror the Mongo schema's hot paths: a composite listing index
 * per drive/folder, and a unique share token.
 */
export class CloudDrive1788080000000 implements MigrationInterface {
  name = 'CloudDrive1788080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── drive_folders ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "drive_folders" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "scope" character varying NOT NULL DEFAULT 'team',
        "owner_id" character varying(24),
        "parent_folder_id" character varying(24),
        "path" character varying NOT NULL DEFAULT '/',
        "created_by" character varying(24) NOT NULL,
        "created_by_name" character varying,
        "system_managed" boolean NOT NULL DEFAULT false,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_drive_folders_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_drive_folder_org" ON "drive_folders" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_drive_folder_listing" ON "drive_folders" ("organization_id", "scope", "owner_id", "parent_folder_id", "is_deleted")`,
    );

    // ── drive_files ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "drive_files" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "size" integer NOT NULL DEFAULT 0,
        "mime_type" character varying NOT NULL DEFAULT 'application/octet-stream',
        "storage_file_id" character varying(24) NOT NULL,
        "scope" character varying NOT NULL DEFAULT 'team',
        "owner_id" character varying(24),
        "folder_id" character varying(24),
        "uploaded_by" character varying(24) NOT NULL,
        "uploaded_by_name" character varying,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "system_managed" boolean NOT NULL DEFAULT false,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_drive_files_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_drive_file_org" ON "drive_files" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_drive_file_listing" ON "drive_files" ("organization_id", "scope", "owner_id", "folder_id", "is_deleted")`,
    );

    // ── drive_shares ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "drive_shares" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "token" character varying NOT NULL,
        "target_type" character varying NOT NULL,
        "target_id" character varying(24) NOT NULL,
        "scope" character varying NOT NULL,
        "permission" character varying NOT NULL DEFAULT 'download',
        "password_hash" character varying,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "revoked" boolean NOT NULL DEFAULT false,
        "access_count" integer NOT NULL DEFAULT 0,
        "last_accessed_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24) NOT NULL,
        "created_by_name" character varying,
        CONSTRAINT "PK_drive_shares_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_drive_share_token" ON "drive_shares" ("token")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_drive_share_creator" ON "drive_shares" ("organization_id", "created_by", "revoked")`,
    );

    // ── drive_quotas ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "drive_quotas" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "owner_id" character varying(24),
        "limit_bytes" bigint NOT NULL DEFAULT 0,
        "default_user_limit_bytes" bigint,
        CONSTRAINT "PK_drive_quotas_id" PRIMARY KEY ("id")
      )
    `);
    // One per-user override row per (org, user); one team-pool row per org.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_drive_quota_scope" ON "drive_quotas" ("organization_id", "owner_id") WHERE "owner_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_drive_quota_team" ON "drive_quotas" ("organization_id") WHERE "owner_id" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "drive_quotas"`);
    await queryRunner.query(`DROP TABLE "drive_shares"`);
    await queryRunner.query(`DROP TABLE "drive_files"`);
    await queryRunner.query(`DROP TABLE "drive_folders"`);
  }
}
