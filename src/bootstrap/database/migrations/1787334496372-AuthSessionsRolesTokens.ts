import { MigrationInterface, QueryRunner } from "typeorm";

export class AuthSessionsRolesTokens1787334496372 implements MigrationInterface {
    name = 'AuthSessionsRolesTokens1787334496372'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "sessions" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" character varying(24) NOT NULL, "refresh_token_family" character varying NOT NULL, "device_info" character varying NOT NULL DEFAULT 'Unknown', "ip_address" character varying, "is_revoked" boolean NOT NULL DEFAULT false, "last_used_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_085d540d9f418cfbdc7bd55bb1" ON "sessions" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e9bb2aa41705acdb5aa8c1ccba" ON "sessions" ("refresh_token_family") `);
        await queryRunner.query(`CREATE INDEX "IDX_9cfe37d28c3b229a350e086d94" ON "sessions" ("expires_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_0d097893cb071f8a2cb340a0bf" ON "sessions" ("user_id", "is_revoked") `);
        await queryRunner.query(`CREATE TABLE "roles" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "organization_id" character varying(24) NOT NULL, "name" character varying NOT NULL, "display_name" character varying, "description" text, "department_id" character varying(24), "permissions" jsonb NOT NULL DEFAULT '[]', "is_deleted" boolean NOT NULL DEFAULT false, "created_by" character varying(24), CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c328a1ecd12a5f153a96df4509" ON "roles" ("organization_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f9842b21d158bb60985c03a981" ON "roles" ("department_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5e7f83d46f62347d5aa3df8799" ON "roles" ("organization_id", "is_deleted") `);
        await queryRunner.query(`CREATE TABLE "revoked_tokens" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "jti" character varying NOT NULL, "user_id" character varying(24), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_5c2b3ed5a8f0e4972e358985038" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b18aa48269f87cafba8c631062" ON "revoked_tokens" ("jti") `);
        await queryRunner.query(`CREATE INDEX "IDX_5aee0c1828e7b9238ca3fe47bc" ON "revoked_tokens" ("expires_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5aee0c1828e7b9238ca3fe47bc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b18aa48269f87cafba8c631062"`);
        await queryRunner.query(`DROP TABLE "revoked_tokens"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5e7f83d46f62347d5aa3df8799"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f9842b21d158bb60985c03a981"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c328a1ecd12a5f153a96df4509"`);
        await queryRunner.query(`DROP TABLE "roles"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0d097893cb071f8a2cb340a0bf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9cfe37d28c3b229a350e086d94"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e9bb2aa41705acdb5aa8c1ccba"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_085d540d9f418cfbdc7bd55bb1"`);
        await queryRunner.query(`DROP TABLE "sessions"`);
    }

}
