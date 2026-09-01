import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll Phase C — investment declarations. `tax_declarations`: one row per
 * (org, user, financial year) holding the employee's self-declared old-regime
 * investments + proofs + a submit/verify workflow. Verified figures drive the
 * old-regime TDS computation. Additive/reversible.
 */
export class TaxDeclaration1787940000000 implements MigrationInterface {
  name = 'TaxDeclaration1787940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tax_declarations" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "financial_year_start" integer NOT NULL,
        "regime" character varying NOT NULL DEFAULT 'new',
        "section80_c" integer NOT NULL DEFAULT 0,
        "section80_d" integer NOT NULL DEFAULT 0,
        "section80_e" integer NOT NULL DEFAULT 0,
        "home_loan_interest" integer NOT NULL DEFAULT 0,
        "hra_exemption_annual" integer NOT NULL DEFAULT 0,
        "other_exemptions" integer NOT NULL DEFAULT 0,
        "proofs" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "status" character varying NOT NULL DEFAULT 'draft',
        "submitted_at" TIMESTAMP WITH TIME ZONE,
        "reviewed_by" character varying(24),
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "review_note" text,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_tax_declarations_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ux_tax_declaration_fy" ON "tax_declarations" ("organization_id", "user_id", "financial_year_start", "is_deleted")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tax_declarations"`);
  }
}
