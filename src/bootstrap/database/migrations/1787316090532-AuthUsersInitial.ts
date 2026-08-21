import { MigrationInterface, QueryRunner } from "typeorm";

export class AuthUsersInitial1787316090532 implements MigrationInterface {
    name = 'AuthUsersInitial1787316090532'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "email" character varying NOT NULL, "password" character varying, "first_name" character varying NOT NULL, "last_name" character varying NOT NULL DEFAULT '', "avatar" text, "is_email_verified" boolean NOT NULL DEFAULT false, "email_verification_token" character varying, "email_verification_expiry" TIMESTAMP WITH TIME ZONE, "phone_number" character varying, "is_phone_verified" boolean NOT NULL DEFAULT false, "phone_verification_token" character varying, "phone_verification_expiry" TIMESTAMP WITH TIME ZONE, "job_title" character varying, "department" character varying, "bio" text, "location" character varying, "timezone" character varying, "linked_in" character varying, "github" character varying, "mfa_enabled" boolean NOT NULL DEFAULT false, "mfa_method" character varying, "mfa_secret" character varying, "mfa_backup_codes" text array, "last_login" TIMESTAMP WITH TIME ZONE, "last_login_ip" character varying, "tokens_valid_from" TIMESTAMP WITH TIME ZONE, "login_attempts" integer NOT NULL DEFAULT '0', "lock_until" TIMESTAMP WITH TIME ZONE, "is_active" boolean NOT NULL DEFAULT true, "deleted_at" TIMESTAMP WITH TIME ZONE, "setup_stage" character varying NOT NULL DEFAULT 'otp_verified', "default_organization_id" character varying(24), "last_org_id" character varying(24), "organizations" text array NOT NULL DEFAULT '{}', "roles" text array NOT NULL DEFAULT '{user}', "permissions" text array NOT NULL DEFAULT '{}', "oauth_providers" jsonb, "is_platform_admin" boolean NOT NULL DEFAULT false, "preferences" jsonb, "otp" character varying, "otp_expires_at" TIMESTAMP WITH TIME ZONE, "otp_attempts" integer NOT NULL DEFAULT '0', "otp_last_requested_at" TIMESTAMP WITH TIME ZONE, "otp_request_count" integer NOT NULL DEFAULT '0', "gdpr_deletion_requested" boolean NOT NULL DEFAULT false, "gdpr_deletion_requested_at" TIMESTAMP WITH TIME ZONE, "gdpr_deletion_scheduled_at" TIMESTAMP WITH TIME ZONE, "gdpr_deletion_reason" character varying, CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email") `);
        await queryRunner.query(`CREATE INDEX "IDX_3b2c3d6acc95b0b8ad2ac3344d" ON "users" ("setup_stage") `);
        await queryRunner.query(`CREATE INDEX "IDX_e791a18af6bb690a8fd9c3bf5f" ON "users" ("is_platform_admin") `);
        await queryRunner.query(`CREATE INDEX "IDX_d86ca1310ceeeffedab94a3c16" ON "users" ("gdpr_deletion_scheduled_at") `);
        await queryRunner.query(`CREATE TABLE "org_memberships" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" character varying(24), "organization_id" character varying(24) NOT NULL, "email" character varying, "role_id" character varying(24), "secondary_role_id" character varying(24), "role" character varying NOT NULL DEFAULT 'employee', "department" character varying, "client_id" character varying(24), "vendor_id" character varying(24), "vendor_employee_id" character varying(24), "status" character varying NOT NULL DEFAULT 'active', "invited_by" character varying(24), "invite_token" character varying, "invite_expires_at" TIMESTAMP WITH TIME ZONE, "invited_at" TIMESTAMP WITH TIME ZONE, "joined_at" TIMESTAMP WITH TIME ZONE, "deactivated_at" TIMESTAMP WITH TIME ZONE, "deactivated_by" character varying(24), "cloud_drive" jsonb, CONSTRAINT "PK_93302068fabd778ba9897219c38" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_21620e5f0bf90d145fec09bee9" ON "org_memberships" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_56885f8072df21349b71206855" ON "org_memberships" ("organization_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_37b4b0237fdb56db97651275b1" ON "org_memberships" ("client_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_eb9cb9bdcc4cb9548ff819c83e" ON "org_memberships" ("vendor_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2411ec510860dbb50a832e5364" ON "org_memberships" ("vendor_employee_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5911f08ffd28c74a430d9076c5" ON "org_memberships" ("invite_token") WHERE "invite_token" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_98a2e2902b476ec688581e2541" ON "org_memberships" ("organization_id", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_membership_email_org" ON "org_memberships" ("email", "organization_id") WHERE "email" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_membership_user_org" ON "org_memberships" ("user_id", "organization_id") WHERE "user_id" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_membership_user_org"`);
        await queryRunner.query(`DROP INDEX "public"."uq_membership_email_org"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_98a2e2902b476ec688581e2541"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5911f08ffd28c74a430d9076c5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2411ec510860dbb50a832e5364"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eb9cb9bdcc4cb9548ff819c83e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_37b4b0237fdb56db97651275b1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_56885f8072df21349b71206855"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_21620e5f0bf90d145fec09bee9"`);
        await queryRunner.query(`DROP TABLE "org_memberships"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d86ca1310ceeeffedab94a3c16"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e791a18af6bb690a8fd9c3bf5f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3b2c3d6acc95b0b8ad2ac3344d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
