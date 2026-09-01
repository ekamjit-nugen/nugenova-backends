import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll Phase C (TDS) — per-employee tax inputs (regime + declared deductions)
 * on the salary structure, and a year-to-date block on the payslip. Additive jsonb
 * columns; safe/reversible.
 */
export class PayrollTds1787930000000 implements MigrationInterface {
  name = 'PayrollTds1787930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "salary_structures" ADD COLUMN "tax_inputs" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(`ALTER TABLE "payslips" ADD COLUMN "tds" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE "payslips" ADD COLUMN "ytd" jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "ytd"`);
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "tds"`);
    await queryRunner.query(`ALTER TABLE "salary_structures" DROP COLUMN "tax_inputs"`);
  }
}
