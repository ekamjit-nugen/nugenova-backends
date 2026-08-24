import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terms & Conditions consent gate.
 *  - `platform_terms` — versioned global T&C (append-only; current = max version).
 *  - `organizations.consent` — the org's acceptance (version + who/when/ip).
 *
 * The org lifecycle gate moves from document-approval to consent: a new org (or
 * one whose accepted version is stale after a T&C change) must re-accept before
 * its owner can use the app. Documents become non-blocking; `suspended` is now a
 * manual halt.
 */
export class TermsConsent1787680000000 implements MigrationInterface {
  name = 'TermsConsent1787680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "platform_terms" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "text" text NOT NULL, "updated_by" character varying(24), CONSTRAINT "PK_platform_terms_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_platform_terms_version" ON "platform_terms" ("version")`,
    );
    await queryRunner.query(`ALTER TABLE "organizations" ADD "consent" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "consent"`);
    await queryRunner.query(`DROP INDEX "public"."uq_platform_terms_version"`);
    await queryRunner.query(`DROP TABLE "platform_terms"`);
  }
}
