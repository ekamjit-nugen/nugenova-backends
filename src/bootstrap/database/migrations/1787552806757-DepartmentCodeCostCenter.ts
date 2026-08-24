import { MigrationInterface, QueryRunner } from "typeorm";

export class DepartmentCodeCostCenter1787552806757 implements MigrationInterface {
    name = 'DepartmentCodeCostCenter1787552806757'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "departments" ADD "code" character varying`);
        await queryRunner.query(`ALTER TABLE "departments" ADD "cost_center" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "departments" DROP COLUMN "cost_center"`);
        await queryRunner.query(`ALTER TABLE "departments" DROP COLUMN "code"`);
    }

}
