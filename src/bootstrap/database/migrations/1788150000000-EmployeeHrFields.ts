import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Employee HR attributes carried over from the legacy Nugen (Mongo) employee
 * record, which has no dedicated table here — the person IS the user + the
 * org membership. Person-level facts (date of birth, skills) land on `users`;
 * employment facts that are per-organization (employee code, employment type,
 * joining date) land on `org_memberships`. All nullable, no backfill.
 */
export class EmployeeHrFields1788150000000 implements MigrationInterface {
  name = 'EmployeeHrFields1788150000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // users: person-level HR attributes
    await queryRunner.query(
      `ALTER TABLE "users" ADD "date_of_birth" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "users" ADD "skills" jsonb`);

    // org_memberships: per-org employment attributes
    await queryRunner.query(
      `ALTER TABLE "org_memberships" ADD "employee_code" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_memberships" ADD "employment_type" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_memberships" ADD "joining_date" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_memberships" DROP COLUMN "joining_date"`);
    await queryRunner.query(`ALTER TABLE "org_memberships" DROP COLUMN "employment_type"`);
    await queryRunner.query(`ALTER TABLE "org_memberships" DROP COLUMN "employee_code"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "skills"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "date_of_birth"`);
  }
}
