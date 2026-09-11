import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * In-PDF signing for client agreements: `fields` holds the signature/name/date
 * boxes placed on the attached PDF, and `signed_file_id` the flattened,
 * signature-embedded PDF produced when the client signs.
 */
export class ClientAgreementFields1788320000000 implements MigrationInterface {
  name = 'ClientAgreementFields1788320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "client_agreements" ADD COLUMN IF NOT EXISTS "fields" jsonb`);
    await queryRunner.query(`ALTER TABLE "client_agreements" ADD COLUMN IF NOT EXISTS "signed_file_id" character varying(24)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "client_agreements" DROP COLUMN IF EXISTS "signed_file_id"`);
    await queryRunner.query(`ALTER TABLE "client_agreements" DROP COLUMN IF EXISTS "fields"`);
  }
}
