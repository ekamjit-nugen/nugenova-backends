import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Attendance (Phase 1) — the `attendance` and `holidays` tables.
 *
 * Additive and reversible; the Mongo monolith is untouched. Mirrors
 * AttendanceEntity / HolidayEntity. The two partial-UNIQUE indexes reproduce the
 * monolith's Mongo partial indexes: one live SYSTEM record per (org, employee,
 * day), and one live holiday per (org, date).
 */
export class AttendanceHolidays1787800000000 implements MigrationInterface {
  name = 'AttendanceHolidays1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "attendance" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24),
        "employee_id" character varying(24) NOT NULL,
        "vendor_id" character varying(24),
        "vendor_employee_id" character varying(24),
        "date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "check_in_time" TIMESTAMP WITH TIME ZONE,
        "check_out_time" TIMESTAMP WITH TIME ZONE,
        "check_in_ip" character varying,
        "check_out_ip" character varying,
        "check_in_location" jsonb,
        "check_out_location" jsonb,
        "work_segments" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "geo_check" jsonb,
        "total_working_hours" double precision,
        "effective_working_hours" double precision,
        "overtime_hours" double precision NOT NULL DEFAULT 0,
        "status" character varying NOT NULL DEFAULT 'present',
        "is_late_arrival" boolean NOT NULL DEFAULT false,
        "late_by_minutes" integer NOT NULL DEFAULT 0,
        "is_early_departure" boolean NOT NULL DEFAULT false,
        "early_by_minutes" integer NOT NULL DEFAULT 0,
        "is_night_shift" boolean NOT NULL DEFAULT false,
        "applied_shift_policy_id" character varying(24),
        "entry_type" character varying NOT NULL DEFAULT 'system',
        "approval_status" character varying,
        "approved_by" character varying(24),
        "approved_at" TIMESTAMP WITH TIME ZONE,
        "rejection_reason" text,
        "pending_edit" jsonb,
        "notes" text,
        "missed_checkout" boolean NOT NULL DEFAULT false,
        "auto_checked_out" boolean NOT NULL DEFAULT false,
        "missed_checkout_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        CONSTRAINT "PK_attendance_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_attendance_organization_id" ON "attendance" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_attendance_employee_id" ON "attendance" ("employee_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_attendance_org_emp_day" ON "attendance" ("organization_id", "employee_id", "date") WHERE "entry_type" = 'system' AND "is_deleted" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_attendance_emp_date" ON "attendance" ("employee_id", "date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_attendance_org_date" ON "attendance" ("organization_id", "date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_attendance_org_status" ON "attendance" ("organization_id", "status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "holidays" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "name" character varying(200) NOT NULL,
        "type" character varying NOT NULL DEFAULT 'national',
        "description" character varying(500),
        "year" integer NOT NULL,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        CONSTRAINT "PK_holidays_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_holidays_organization_id" ON "holidays" ("organization_id")`,
    );
    await queryRunner.query(`CREATE INDEX "ix_holidays_date" ON "holidays" ("date")`);
    await queryRunner.query(`CREATE INDEX "ix_holidays_year" ON "holidays" ("year")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_holiday_org_date" ON "holidays" ("organization_id", "date") WHERE "is_deleted" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_holiday_org_year" ON "holidays" ("organization_id", "year", "is_deleted")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "holidays"`);
    await queryRunner.query(`DROP TABLE "attendance"`);
  }
}
