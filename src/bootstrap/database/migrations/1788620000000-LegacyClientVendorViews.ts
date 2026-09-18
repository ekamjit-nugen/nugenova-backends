import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compatibility views so a pre-merge build can still read and write clients and
 * vendors after `Partners1788590000000` renamed those tables away.
 *
 * This exists because of a real outage. The partner migrations were applied to
 * production while the deployed API still mapped `@Entity('clients')` and three
 * siblings to tables that no longer existed, so every request touching them —
 * including the dashboard's `/clients/overview`, which loads for anyone with
 * `clients: view` — returned a 500. A rename is a breaking change to whatever
 * is already running, and needs either the deploy first or a bridge like this.
 *
 * The old column sets are strict subsets of the merged tables, so each view is
 * a plain projection. Reads, UPDATEs and DELETEs work through Postgres's
 * auto-updatable views; INSERTs can't set the NOT NULL `category`, so each view
 * gets an INSTEAD OF INSERT trigger that supplies it. One function per view,
 * not one shared one: PL/pgSQL resolves `NEW.<field>` at runtime, so a function
 * naming vendor-only columns fails the moment it runs on the clients view.
 *
 * TEMPORARY. Once every deployed build serves the partner code, drop these —
 * `down()` is exactly that, and it destroys nothing, since the views are only a
 * projection of `partners` and `partner_contacts`.
 */
export class LegacyClientVendorViews1788620000000 implements MigrationInterface {
  name = 'LegacyClientVendorViews1788620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "clients" AS
        SELECT id, created_at, updated_at, organization_id, company_name, display_name,
               industry, website, status, tags, notes, primary_contact, created_by,
               updated_by, is_deleted, portal_enabled
        FROM partners WHERE category = 'client'
    `);
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "vendors" AS
        SELECT id, created_at, updated_at, organization_id, company_name, display_name,
               service_category, website, tax_id, currency, status, onboarding_status,
               onboarded_at, time_tracking_enabled, billing_address, primary_contact,
               tags, notes, created_by, updated_by, is_deleted, portal_enabled
        FROM partners WHERE category = 'vendor'
    `);
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "client_contacts" AS
        SELECT id, created_at, updated_at, organization_id, client_id, name, email,
               phone, designation, user_id, is_deleted
        FROM partner_contacts WHERE category = 'client'
    `);
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "vendor_contacts" AS
        SELECT id, created_at, updated_at, organization_id, vendor_id, name, email,
               phone, designation, is_primary, user_id, is_deleted
        FROM partner_contacts WHERE category = 'vendor'
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION compat_insert_client() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO partners (id, created_at, updated_at, organization_id, category,
          company_name, display_name, industry, website, status, tags, notes,
          primary_contact, portal_enabled, created_by, updated_by, is_deleted)
        VALUES (NEW.id, COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now()),
          NEW.organization_id, 'client', NEW.company_name, NEW.display_name, NEW.industry,
          NEW.website, NEW.status, COALESCE(NEW.tags, '{}'), NEW.notes, NEW.primary_contact,
          COALESCE(NEW.portal_enabled, false), NEW.created_by, NEW.updated_by,
          COALESCE(NEW.is_deleted, false));
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION compat_insert_vendor() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO partners (id, created_at, updated_at, organization_id, category,
          company_name, display_name, service_category, website, tax_id, currency, status,
          onboarding_status, onboarded_at, time_tracking_enabled, billing_address, tags,
          notes, primary_contact, portal_enabled, created_by, updated_by, is_deleted)
        VALUES (NEW.id, COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now()),
          NEW.organization_id, 'vendor', NEW.company_name, NEW.display_name,
          NEW.service_category, NEW.website, NEW.tax_id, NEW.currency, NEW.status,
          NEW.onboarding_status, NEW.onboarded_at, NEW.time_tracking_enabled,
          NEW.billing_address, COALESCE(NEW.tags, '{}'), NEW.notes, NEW.primary_contact,
          COALESCE(NEW.portal_enabled, false), NEW.created_by, NEW.updated_by,
          COALESCE(NEW.is_deleted, false));
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION compat_insert_client_contact() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO partner_contacts (id, created_at, updated_at, organization_id,
          category, client_id, name, email, phone, designation, is_primary, user_id, is_deleted)
        VALUES (NEW.id, COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now()),
          NEW.organization_id, 'client', NEW.client_id, NEW.name, NEW.email, NEW.phone,
          NEW.designation, false, NEW.user_id, COALESCE(NEW.is_deleted, false));
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION compat_insert_vendor_contact() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO partner_contacts (id, created_at, updated_at, organization_id,
          category, vendor_id, name, email, phone, designation, is_primary, user_id, is_deleted)
        VALUES (NEW.id, COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now()),
          NEW.organization_id, 'vendor', NEW.vendor_id, NEW.name, NEW.email, NEW.phone,
          NEW.designation, COALESCE(NEW.is_primary, false), NEW.user_id,
          COALESCE(NEW.is_deleted, false));
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql
    `);

    // CREATE TRIGGER has no OR REPLACE before PG 14 — drop first so a re-run is
    // a no-op rather than a duplicate-object failure.
    for (const [view, fn] of [
      ['clients', 'compat_insert_client'],
      ['vendors', 'compat_insert_vendor'],
      ['client_contacts', 'compat_insert_client_contact'],
      ['vendor_contacts', 'compat_insert_vendor_contact'],
    ]) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "compat_${view}_insert" ON "${view}"`);
      await queryRunner.query(
        `CREATE TRIGGER "compat_${view}_insert" INSTEAD OF INSERT ON "${view}"
         FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
}
