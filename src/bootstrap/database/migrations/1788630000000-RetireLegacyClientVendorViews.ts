import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire the clients/vendors compatibility views.
 *
 * `LegacyClientVendorViews1788620000000` added them to keep a pre-merge build
 * serving after the partner migrations renamed those tables away. That build is
 * gone — production serves the partner code — so the views are no longer read by
 * anything, and an unused view named `clients` is a tripwire: a later migration
 * creating a table by that name would collide with it.
 *
 * The pair is deliberately left as two migrations rather than deleting the
 * first. Production already recorded it as applied, and a migration name with no
 * code behind it is a puzzle for whoever reads the table next. This way the
 * bridge's whole life — why it appeared, when it was retired — is in the history.
 *
 * Nothing is destroyed: the views were a projection of `partners` and
 * `partner_contacts`, which are untouched. `down()` is the previous migration's
 * `up()`, should a pre-merge build ever need to run again.
 */
export class RetireLegacyClientVendorViews1788630000000 implements MigrationInterface {
  name = 'RetireLegacyClientVendorViews1788630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP VIEW IF EXISTS "clients", "vendors", "client_contacts", "vendor_contacts" CASCADE`,
    );
    for (const fn of [
      'compat_insert_client',
      'compat_insert_vendor',
      'compat_insert_client_contact',
      'compat_insert_vendor_contact',
    ]) {
      await queryRunner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  }

  public async down(): Promise<void> {
    // Intentionally empty. Recreating the bridge means reverting
    // LegacyClientVendorViews1788620000000 as well, which rebuilds the views and
    // their triggers together — doing half of it here would leave views that
    // cannot be inserted into.
  }
}
