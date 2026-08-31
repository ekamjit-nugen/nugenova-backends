import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-employee recurring deductions on the salary structure — fixed monthly
 * employee-side recoveries (loan EMI, salary advance, fines) that aren't org-wide
 * statutory/custom lines. Additive jsonb column; safe/reversible.
 */
export class PayrollRecurringDeductions1787910000000 implements MigrationInterface {
  name = 'PayrollRecurringDeductions1787910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "salary_structures" ADD COLUMN "recurring_deductions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "salary_structures" DROP COLUMN "recurring_deductions"`);
  }
}
