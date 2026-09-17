import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire the built-in Owner, Admin, Manager and Employee roles.
 *
 * These rows never carried access of their own: owner/admin get full access from
 * the membership's tier (`org_memberships.role`), and Manager/Employee shipped
 * with empty permission matrices. They existed so a member without a custom role
 * still showed one — at the cost of four locked-looking, mostly empty roles on
 * every org's Roles page.
 *
 * A member who pointed at one of these rows is unlinked first (role or
 * secondary role → NULL). Their TIER is left alone, so nobody gains or loses
 * access; they simply show "No custom role".
 *
 * Only `is_system` rows with exactly these names are touched. The education
 * pack's built-in roles (Principal, Teacher, …) are not, and neither is any
 * custom role an org happens to have named "admin" or "manager".
 *
 * down() restores the rows but cannot re-link the members that were unlinked;
 * reassign those by hand if this is ever rolled back.
 */
export class RetireTierRoles1788500000000 implements MigrationInterface {
  name = 'RetireTierRoles1788500000000';

  public async up(q: QueryRunner): Promise<void> {
    const retiring = `
      SELECT r."id" FROM "roles" r
       WHERE r."is_system" = true
         AND r."name" IN ('owner', 'admin', 'manager', 'employee')
         AND r."is_deleted" = false`;

    await q.query(`UPDATE "org_memberships" SET "role_id" = NULL WHERE "role_id" IN (${retiring})`);
    await q.query(
      `UPDATE "org_memberships" SET "secondary_role_id" = NULL WHERE "secondary_role_id" IN (${retiring})`,
    );
    await q.query(`
      UPDATE "roles"
         SET "is_deleted" = true,
             "updated_at" = now()
       WHERE "is_system" = true
         AND "name" IN ('owner', 'admin', 'manager', 'employee')
         AND "is_deleted" = false
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "roles"
         SET "is_deleted" = false,
             "updated_at" = now()
       WHERE "is_system" = true
         AND "name" IN ('owner', 'admin', 'manager', 'employee')
         AND "is_deleted" = true
    `);
  }
}
