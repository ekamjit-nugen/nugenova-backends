import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll Phase C — statutory identifiers. Employee PAN/UAN/ESIC on the salary
 * structure (sticky across revisions), used to fill the register & Form 16
 * identity columns. Employer TAN/PAN live on the payroll-config policy row (jsonb),
 * so no schema change is needed for those. Additive/reversible.
 */
export class StatutoryIds1787950000000 implements MigrationInterface {
  name = 'StatutoryIds1787950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "salary_structures" ADD COLUMN "statutory_ids" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "salary_structures" DROP COLUMN "statutory_ids"`);
  }
}
