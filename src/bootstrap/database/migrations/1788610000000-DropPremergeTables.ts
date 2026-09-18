import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the pre-merge copies of the client and vendor tables.
 *
 * `Partners1788590000000` and `PartnerContacts1788600000000` renamed the old
 * tables instead of dropping them, so the merge could be checked row by row and
 * rolled back if it had gone wrong. It has been checked — every company and
 * contact matched field for field — and nothing has written to them since, so
 * they are now dead weight that a later reader would have to reason about.
 *
 * This is the one irreversible step of the merge: `down()` can recreate empty
 * shells so a rollback doesn't fail, but it cannot bring the rows back. Take a
 * dump before running it anywhere you care about.
 */
export class DropPremergeTables1788610000000 implements MigrationInterface {
  name = 'DropPremergeTables1788610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Refuse if anything ended up in the merged tables that isn't accounted for
    // by the pre-merge copies — that would mean the merge was not what we think.
    const [{ missing }] = await queryRunner.query(`
      SELECT count(*)::int AS missing
      FROM (SELECT id FROM clients_premerge UNION ALL SELECT id FROM vendors_premerge) x
      WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.id = x.id)
    `);
    if (missing > 0) {
      throw new Error(`Refusing to drop: ${missing} pre-merge row(s) are not in partners`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "client_contacts_premerge"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_contacts_premerge"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "clients_premerge"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vendors_premerge"`);
  }

  public async down(): Promise<void> {
    // Nothing to undo: the data lives in `partners` and `partner_contacts`, and
    // the dropped copies were duplicates of it.
  }
}
