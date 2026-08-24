import { MigrationInterface, QueryRunner } from "typeorm";

export class OrganizationDepartments1787546870935 implements MigrationInterface {
    name = 'OrganizationDepartments1787546870935'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "organizations" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying NOT NULL, "slug" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'active', "owner_id" character varying(24), "created_by" character varying(24), "settings" jsonb, "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_6b031fcd0863e3f6b44230163f9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_963693341bd612aa01ddf3a4b6" ON "organizations" ("slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_e08c0b40ce104f44edf060126f" ON "organizations" ("owner_id") `);
        await queryRunner.query(`CREATE TABLE "departments" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "organization_id" character varying(24) NOT NULL, "name" character varying NOT NULL, "description" text, "head_user_id" character varying(24), "parent_department_id" character varying(24), "is_deleted" boolean NOT NULL DEFAULT false, "created_by" character varying(24), CONSTRAINT "PK_839517a681a86bb84cbcc6a1e9d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_71070628c130f2c9cd3cd5f082" ON "departments" ("organization_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_department_org_name" ON "departments" ("organization_id", "name") WHERE "is_deleted" = false`);
        await queryRunner.query(`ALTER TABLE "org_memberships" ADD "department_id" character varying(24)`);
        await queryRunner.query(`CREATE INDEX "IDX_483697c3591371f4fbb950c883" ON "org_memberships" ("department_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_483697c3591371f4fbb950c883"`);
        await queryRunner.query(`ALTER TABLE "org_memberships" DROP COLUMN "department_id"`);
        await queryRunner.query(`DROP INDEX "public"."uq_department_org_name"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_71070628c130f2c9cd3cd5f082"`);
        await queryRunner.query(`DROP TABLE "departments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e08c0b40ce104f44edf060126f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_963693341bd612aa01ddf3a4b6"`);
        await queryRunner.query(`DROP TABLE "organizations"`);
    }

}
