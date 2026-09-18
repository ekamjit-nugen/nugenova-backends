import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vendors — supplier companies (staffing partners, subcontractors), the people
 * they supply, and the contacts we deal with there.
 *
 * `org_memberships.vendor_id` and `attendance.vendor_employee_id` have pointed
 * at these tables since the first migration; this is the first time the targets
 * actually exist. No FK is added: those columns predate the tables and may hold
 * ids from the legacy system, so a constraint would fail on existing rows.
 */
export class Vendors1788530000000 implements MigrationInterface {
  name = 'Vendors1788530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendors" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "company_name" character varying NOT NULL,
        "display_name" character varying,
        "service_category" character varying NOT NULL DEFAULT 'other',
        "website" character varying,
        "tax_id" character varying,
        "currency" character varying NOT NULL DEFAULT 'INR',
        "status" character varying NOT NULL DEFAULT 'active',
        "onboarding_status" character varying NOT NULL DEFAULT 'invited',
        "onboarded_at" TIMESTAMP WITH TIME ZONE,
        "time_tracking_enabled" boolean NOT NULL DEFAULT false,
        "billing_address" jsonb,
        "primary_contact" jsonb,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notes" text,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_vendors" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendors_org_status" ON "vendors" ("organization_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendors_org_deleted" ON "vendors" ("organization_id", "is_deleted")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_contacts" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "vendor_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "email" character varying,
        "phone" character varying,
        "designation" character varying,
        "is_primary" boolean NOT NULL DEFAULT false,
        "user_id" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_vendor_contacts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_contacts_vendor" ON "vendor_contacts" ("vendor_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_contacts_org" ON "vendor_contacts" ("organization_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_employees" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "vendor_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "email" character varying,
        "phone" character varying,
        "designation" character varying,
        "skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "employment_type" character varying NOT NULL DEFAULT 'contract',
        "status" character varying NOT NULL DEFAULT 'active',
        "rate_amount" numeric(12,2),
        "rate_currency" character varying NOT NULL DEFAULT 'INR',
        "rate_unit" character varying NOT NULL DEFAULT 'day',
        "linked_user_id" character varying(24),
        "notes" text,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_vendor_employees" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_employees_vendor" ON "vendor_employees" ("vendor_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_employees_org_status" ON "vendor_employees" ("organization_id", "status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_employees"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_contacts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vendors"`);
  }
}
