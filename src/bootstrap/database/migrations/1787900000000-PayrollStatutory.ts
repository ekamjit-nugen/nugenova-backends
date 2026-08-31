import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll Phase 2 (statutory) — salary component breakdown + payslip line items
 * (earnings / deductions / employer contributions) and statutory totals. Additive
 * columns on the existing tables; safe/reversible.
 */
export class PayrollStatutory1787900000000 implements MigrationInterface {
  name = 'PayrollStatutory1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Salary component breakdown (Basic/HRA/allowances). Null ⇒ legacy single-lump.
    await queryRunner.query(
      `ALTER TABLE "salary_structures" ADD COLUMN "components" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    // Payslip line items + statutory totals.
    await queryRunner.query(`ALTER TABLE "payslips" ADD COLUMN "earnings" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "payslips" ADD COLUMN "deductions" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "payslips" ADD COLUMN "employer_contributions" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "payslips" ADD COLUMN "statutory" jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "statutory"`);
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "employer_contributions"`);
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "deductions"`);
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "earnings"`);
    await queryRunner.query(`ALTER TABLE "salary_structures" DROP COLUMN "components"`);
  }
}
