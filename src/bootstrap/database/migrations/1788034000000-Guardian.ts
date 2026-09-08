import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Guardian link + consent ledger — §04 (client-portal → guardian), §09/§10
 * (consent-gated per learner, DPDP).
 *
 *  - `guardian_links` — guardian membership ↔ student membership, with
 *    relationship + isPrimary. UNIQUE (guardian, student); unlink is soft
 *    (deactivated_at) so consent history keeps resolving.
 *  - `consent_ledger` — append-only consent records per (org, subject, purpose).
 *    A grant is a row; a revoke soft-stamps revoked_at. The mechanism §09 tiers
 *    2–3 gate on.
 */
export class Guardian1788034000000 implements MigrationInterface {
  name = 'Guardian1788034000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── guardian_links ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "guardian_links" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "guardian_membership_id" character varying(24) NOT NULL,
        "student_membership_id" character varying(24) NOT NULL,
        "relationship" character varying(32) NOT NULL DEFAULT 'guardian',
        "is_primary" boolean NOT NULL DEFAULT false,
        "deactivated_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_guardian_links" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_guardian_link_org" ON "guardian_links" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_guardian_link_guardian" ON "guardian_links" ("guardian_membership_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_guardian_link_student" ON "guardian_links" ("student_membership_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_guardian_link_pair" ON "guardian_links" ("guardian_membership_id", "student_membership_id")`,
    );

    // ── consent_ledger ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "consent_ledger" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "subject_membership_id" character varying(24) NOT NULL,
        "purpose" character varying(64) NOT NULL,
        "basis" character varying(16) NOT NULL,
        "granted_by_membership_id" character varying(24) NOT NULL,
        "granted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_membership_id" character varying(24),
        "version" integer NOT NULL DEFAULT 1,
        "created_by" character varying(24),
        CONSTRAINT "PK_consent_ledger" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_consent_org" ON "consent_ledger" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_consent_subject" ON "consent_ledger" ("subject_membership_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_consent_lookup" ON "consent_ledger" ("organization_id", "subject_membership_id", "purpose")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "ix_consent_lookup"`);
    await queryRunner.query(`DROP INDEX "ix_consent_subject"`);
    await queryRunner.query(`DROP INDEX "ix_consent_org"`);
    await queryRunner.query(`DROP TABLE "consent_ledger"`);

    await queryRunner.query(`DROP INDEX "uq_guardian_link_pair"`);
    await queryRunner.query(`DROP INDEX "ix_guardian_link_student"`);
    await queryRunner.query(`DROP INDEX "ix_guardian_link_guardian"`);
    await queryRunner.query(`DROP INDEX "ix_guardian_link_org"`);
    await queryRunner.query(`DROP TABLE "guardian_links"`);
  }
}
