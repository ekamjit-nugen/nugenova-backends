import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire the built-in Member and Viewer roles.
 *
 * Every org was seeded with them, but no membership in any org ever held
 * either one, and nothing in the product assigned their tiers — they were
 * locked, uneditable clutter on the Roles page.
 *
 * Soft delete (is_deleted), matching how roles are removed everywhere else, and
 * guarded: a row that ANY membership references — as its role or its secondary
 * role — is left alone, so this can never strand a member without a role.
 *
 * The `viewer` tier itself is untouched: education Student/Guardian roles map
 * to it on their own rows.
 */
export class RetireMemberViewerRoles1788490000000 implements MigrationInterface {
  name = 'RetireMemberViewerRoles1788490000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "roles" r
         SET "is_deleted" = true,
             "updated_at" = now()
       WHERE r."is_system" = true
         AND r."name" IN ('member', 'viewer')
         AND r."is_deleted" = false
         AND NOT EXISTS (
               SELECT 1 FROM "org_memberships" m
                WHERE m."role_id" = r."id" OR m."secondary_role_id" = r."id"
             )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "roles"
         SET "is_deleted" = false,
             "updated_at" = now()
       WHERE "is_system" = true
         AND "name" IN ('member', 'viewer')
         AND "is_deleted" = true
    `);
  }
}
