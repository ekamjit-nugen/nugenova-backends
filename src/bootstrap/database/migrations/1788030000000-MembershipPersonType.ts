import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * personType on org_memberships — the education-vertical guard. Marks each
 * membership as 'staff' | 'student' | 'guardian'. NOT NULL DEFAULT 'staff' so
 * every existing row is backfilled to staff and every future org-member stays
 * staff unless explicitly enrolled otherwise. Staff-only surfaces (payroll,
 * attendance roster, seat counts, directory) narrow on this via `staffScope()`.
 */
export class MembershipPersonType1788030000000 implements MigrationInterface {
  name = 'MembershipPersonType1788030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_memberships" ADD "person_type" character varying(16) NOT NULL DEFAULT 'staff'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_org_memberships_person_type" ON "org_memberships" ("person_type")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_org_memberships_person_type"`);
    await queryRunner.query(`ALTER TABLE "org_memberships" DROP COLUMN "person_type"`);
  }
}
