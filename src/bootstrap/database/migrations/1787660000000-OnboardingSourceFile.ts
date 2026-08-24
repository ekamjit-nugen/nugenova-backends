import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `onboarding_document_requests.source_file_id` — the PDF a super admin
 * uploads for the owner to fill/sign in place (fields are positioned on it).
 */
export class OnboardingSourceFile1787660000000 implements MigrationInterface {
  name = 'OnboardingSourceFile1787660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "onboarding_document_requests" ADD "source_file_id" character varying(24)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "onboarding_document_requests" DROP COLUMN "source_file_id"`,
    );
  }
}
