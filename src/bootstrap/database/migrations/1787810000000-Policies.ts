import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Policy module — the `policies` and `policy_acknowledgements` tables.
 *
 * Additive and reversible; the Mongo monolith is untouched. Attendance-governing
 * config (workTiming/workLocation/wfhConfig) is first-class jsonb; other category
 * blobs live in `extra_config` until their modules migrate.
 */
export class Policies1787810000000 implements MigrationInterface {
  name = 'Policies1787810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "policies" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24),
        "policy_name" character varying NOT NULL,
        "description" text,
        "category" character varying NOT NULL,
        "work_timing" jsonb,
        "work_location" jsonb,
        "wfh_config" jsonb,
        "extra_config" jsonb,
        "applicable_to" character varying NOT NULL DEFAULT 'all',
        "applicable_ids" text array NOT NULL DEFAULT '{}',
        "excluded_employee_ids" text array NOT NULL DEFAULT '{}',
        "effective_from" TIMESTAMP WITH TIME ZONE,
        "effective_to" TIMESTAMP WITH TIME ZONE,
        "review_date" TIMESTAMP WITH TIME ZONE,
        "version" integer NOT NULL DEFAULT 1,
        "is_template" boolean NOT NULL DEFAULT false,
        "template_name" character varying,
        "source_template_id" character varying(24),
        "acknowledgement_required" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_policies_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_policies_organization_id" ON "policies" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_policy_org_deleted" ON "policies" ("organization_id", "is_deleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_policy_org_category" ON "policies" ("organization_id", "category")`,
    );
    await queryRunner.query(`CREATE INDEX "ix_policy_template" ON "policies" ("is_template")`);

    await queryRunner.query(`
      CREATE TABLE "policy_acknowledgements" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "policy_id" character varying(24) NOT NULL,
        "organization_id" character varying(24) NOT NULL,
        "employee_id" character varying(24) NOT NULL,
        "acknowledged_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "version" integer NOT NULL,
        CONSTRAINT "PK_policy_ack_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_policy_ack_policy_id" ON "policy_acknowledgements" ("policy_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_policy_ack_organization_id" ON "policy_acknowledgements" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_policy_ack_policy_employee" ON "policy_acknowledgements" ("policy_id", "employee_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_policy_ack_employee" ON "policy_acknowledgements" ("employee_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "policy_acknowledgements"`);
    await queryRunner.query(`DROP TABLE "policies"`);
  }
}
