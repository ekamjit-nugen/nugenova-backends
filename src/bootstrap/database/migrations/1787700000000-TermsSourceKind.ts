import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terms & Conditions source kind. A terms version can now be either HTML (from a
 * template or the editor) or an uploaded PDF the org reads and accepts:
 *  - `kind`    — 'html' | 'pdf' (default 'html'; existing rows are html).
 *  - `title`   — human label (template name or PDF filename).
 *  - `file_id` — `document_files` id of the uploaded PDF for the 'pdf' kind.
 *  - `text`    — relaxed to NULLable (null for the 'pdf' kind).
 */
export class TermsSourceKind1787700000000 implements MigrationInterface {
  name = 'TermsSourceKind1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "platform_terms" ADD "kind" character varying NOT NULL DEFAULT 'html'`,
    );
    await queryRunner.query(`ALTER TABLE "platform_terms" ADD "title" character varying`);
    await queryRunner.query(
      `ALTER TABLE "platform_terms" ADD "file_id" character varying(24)`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_terms" ALTER COLUMN "text" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "platform_terms" ALTER COLUMN "text" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "platform_terms" DROP COLUMN "file_id"`);
    await queryRunner.query(`ALTER TABLE "platform_terms" DROP COLUMN "title"`);
    await queryRunner.query(`ALTER TABLE "platform_terms" DROP COLUMN "kind"`);
  }
}
