import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll Phase D (disbursement) — employee bank account on the salary structure,
 * used to build the bank payout (NEFT) file. Additive/reversible jsonb column.
 */
export class BankAccount1787960000000 implements MigrationInterface {
  name = 'BankAccount1787960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "salary_structures" ADD COLUMN "bank_account" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "salary_structures" DROP COLUMN "bank_account"`);
  }
}
