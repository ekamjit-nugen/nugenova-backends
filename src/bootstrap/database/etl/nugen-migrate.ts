/* eslint-disable no-console */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { MongoClient } from 'mongodb';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { RoleEntity } from '../../../modules/auth/entities/role.entity';
import { DepartmentEntity } from '../../../modules/organization/entities/department.entity';
import { HolidayEntity } from '../../../modules/attendance/entities/holiday.entity';
import { AttendanceEntity } from '../../../modules/attendance/entities/attendance.entity';
import { TimesheetEntity } from '../../../modules/timesheet/entities/timesheet.entity';
import { LeaveRequestEntity } from '../../../modules/leave/entities/leave-request.entity';
import { LeaveBalanceEntity } from '../../../modules/leave/entities/leave-balance.entity';

/**
 * Nugen IT Services — legacy Mongo → Postgres data migration.
 *
 * Scoped strictly to ONE legacy org and loaded into ONE target org; every other
 * Mongo `_id` is preserved verbatim as the Postgres 24-char id, so cross-refs
 * resolve and the whole run is IDEMPOTENT (re-run to catch drift). Only the
 * `organizationId` is rewritten (legacy → target). Time-log collections that key
 * off the legacy EMPLOYEE `_id` are remapped to the auth `userId` (Postgres
 * attendance/leave key off the user id, not an HR id).
 *
 * Run:  SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/nugen-migrate.ts
 */

const LEGACY_ORG = '6600000000000000000000a0';
const TARGET_ORG = '6a9fbcc377bf257f21e4b402';
const MONGO_DB = 'nugenova';

// ── helpers ──────────────────────────────────────────────────────────────────
const sid = (v: unknown): string | null => (v == null ? null : String(v));
const dt = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v: unknown, def = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const bool = (v: unknown): boolean => v === true;

const ROLE_TIERS = new Set(['owner', 'admin', 'manager', 'employee', 'member', 'viewer']);
const roleTier = (r: unknown): string => {
  const s = String(r ?? '').toLowerCase();
  return ROLE_TIERS.has(s) ? s : 'employee';
};

async function main() {
  const uri = process.env.SRC_MONGODB_URI;
  if (!uri) throw new Error('SRC_MONGODB_URI not set');
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

  const mc = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await mc.connect();
  const mdb = mc.db(MONGO_DB);

  const ds = new DataSource({
    type: 'postgres',
    url: dbUrl,
    ssl: dbUrl && !isLocal ? { rejectUnauthorized: false } : false,
    entities: [
      RoleEntity, DepartmentEntity, HolidayEntity,
      AttendanceEntity, TimesheetEntity, LeaveRequestEntity, LeaveBalanceEntity,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  await ds.initialize();

  const report: Array<{ step: string; mongo: number; wrote: number; skipped?: number }> = [];
  const log = (step: string, mongo: number, wrote: number, skipped = 0) => {
    report.push({ step, mongo, wrote, skipped });
    console.log(`  ${step.padEnd(22)} mongo=${String(mongo).padStart(5)}  wrote=${String(wrote).padStart(5)}  skipped=${skipped}`);
  };

  // Untyped: the driver's strict Filter<Document> rejects string _id/$in filters
  // (legacy ids are stored as hex strings, not ObjectIds).
  const col = (n: string): any => mdb.collection(n);
  const orgFilter = { organizationId: LEGACY_ORG };

  // ── lookup maps ──────────────────────────────────────────────────────────
  // legacy employee _id → auth userId  (for attendance/leave/balance remap)
  const employees = await col('employees').find(orgFilter).toArray();
  const empToUser = new Map<string, string>();
  for (const e of employees) {
    if (e.userId) empToUser.set(String(e._id), String(e.userId));
  }
  // designation _id → title
  const designations = await col('designations').find(orgFilter).toArray();
  const desigTitle = new Map<string, string>();
  for (const d of designations) desigTitle.set(String(d._id), String(d.title ?? ''));

  // legacy Nugen users = members' users ∪ users whose .organizations includes org
  const memberUserIds = (await col('orgmemberships').distinct('userId', orgFilter))
    .filter(Boolean).map(String);
  const memberUserSet = new Set<string>(memberUserIds);

  // Legacy time-logs are inconsistent: `employeeId` is USUALLY the employee _id,
  // but sometimes already the auth userId. Resolve via the employee→user map,
  // else accept it if it is itself a Nugen member's userId, else it's an orphan.
  const resolveUser = (empId: unknown): string | null => {
    const s = String(empId);
    return empToUser.get(s) ?? (memberUserSet.has(s) ? s : null);
  };
  const users = await col('users').find({
    $or: [
      { _id: { $in: memberUserIds } },
      { organizations: { $elemMatch: { $in: [LEGACY_ORG] } } },
    ],
  }).toArray();

  // ── 1. roles ───────────────────────────────────────────────────────────────
  {
    const docs = await col('roles').find(orgFilter).toArray();
    const repo = ds.getRepository(RoleEntity);
    const rows = docs.map((r) => ({
      id: sid(r._id)!,
      organizationId: TARGET_ORG,
      name: String(r.name ?? 'role'),
      displayName: r.displayName ?? null,
      description: r.description ?? null,
      departmentId: sid(r.departmentId),
      tier: r.tier ?? null,
      isSystem: bool(r.isSystem),
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
      isDeleted: bool(r.isDeleted),
      createdBy: sid(r.createdBy),
      createdAt: dt(r.createdAt) ?? new Date(),
      updatedAt: dt(r.updatedAt) ?? new Date(),
    }));
    if (rows.length) {
      await repo.createQueryBuilder().insert().values(rows as any)
        .orUpdate(repo.metadata.columns.map((c) => c.databaseName).filter((n) => n !== 'id'), ['id'])
        .execute();
    }
    log('roles', docs.length, rows.length);
  }

  // ── 2. departments (upsert by (org, name): the target org has generic seed
  //       departments; merge on name so we don't duplicate "Engineering" etc.) ──
  {
    const docs = await col('departments').find(orgFilter).toArray();
    let wrote = 0;
    for (const d of docs) {
      await ds.query(
        `INSERT INTO departments
          (id,organization_id,name,code,description,cost_center,head_user_id,parent_department_id,is_deleted,created_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (organization_id, name) WHERE is_deleted = false
         DO UPDATE SET code=EXCLUDED.code, description=EXCLUDED.description,
                       cost_center=EXCLUDED.cost_center, updated_at=EXCLUDED.updated_at`,
        [
          sid(d._id), TARGET_ORG, String(d.name ?? 'Department'), d.code ?? null,
          d.description ?? null, d.costCenter ?? null, sid(d.headId), sid(d.parentDepartmentId),
          bool(d.isDeleted), sid(d.createdBy), dt(d.createdAt) ?? new Date(), dt(d.updatedAt) ?? new Date(),
        ],
      );
      wrote++;
    }
    log('departments', docs.length, wrote);
  }

  // ── 3. users (custom upsert: merge organizations, keep password if unknown) ──
  {
    // pre-read existing org arrays so we MERGE rather than clobber
    const ids = users.map((u) => String(u._id));
    const existing = ids.length
      ? await ds.query(`SELECT id, organizations FROM users WHERE id = ANY($1)`, [ids])
      : [];
    const existingOrgs = new Map<string, string[]>(existing.map((r: any) => [r.id, r.organizations ?? []]));
    let wrote = 0;
    for (const u of users) {
      const id = String(u._id);
      const orgs = Array.from(new Set([...(existingOrgs.get(id) ?? []), TARGET_ORG]));
      await ds.query(
        `INSERT INTO users
          (id,email,password,first_name,last_name,avatar,is_email_verified,phone_number,is_phone_verified,
           mfa_enabled,is_active,setup_stage,is_platform_admin,preferences,organizations,roles,permissions,
           default_organization_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::text[],$16::text[],$17::text[],$18,$19,$20)
         ON CONFLICT (id) DO UPDATE SET
           email=EXCLUDED.email,
           password=COALESCE(EXCLUDED.password, users.password),
           first_name=EXCLUDED.first_name,
           last_name=EXCLUDED.last_name,
           avatar=COALESCE(EXCLUDED.avatar, users.avatar),
           phone_number=COALESCE(EXCLUDED.phone_number, users.phone_number),
           is_email_verified=(users.is_email_verified OR EXCLUDED.is_email_verified),
           organizations=EXCLUDED.organizations,
           default_organization_id=COALESCE(users.default_organization_id, EXCLUDED.default_organization_id),
           updated_at=EXCLUDED.updated_at`,
        [
          id,
          String(u.email),
          u.password ?? null,
          String(u.firstName ?? ''),
          String(u.lastName ?? ''),
          u.avatar ?? null,
          bool(u.isEmailVerified),
          u.phoneNumber ?? null,
          bool(u.isPhoneVerified),
          bool(u.mfaEnabled),
          u.isActive !== false,
          String(u.setupStage ?? 'completed'),
          bool(u.isPlatformAdmin),
          JSON.stringify(u.preferences ?? null),
          orgs,
          ['user'],
          [],
          TARGET_ORG,
          dt(u.createdAt) ?? new Date(),
          dt(u.updatedAt) ?? new Date(),
        ],
      );
      wrote++;
    }
    log('users', users.length, wrote);
  }

  // ── 4. org memberships (conditional conflict target: user_id vs email) ───────
  {
    const docs = await col('orgmemberships').find(orgFilter).toArray();
    let wrote = 0;
    for (const m of docs) {
      const userId = sid(m.userId);
      const base = [
        sid(m._id)!, userId, TARGET_ORG, m.email ?? null, sid(m.roleId),
        roleTier(m.role), 'staff', String(m.status ?? 'active'),
        dt(m.joinedAt), dt(m.createdAt) ?? new Date(), dt(m.updatedAt) ?? new Date(),
      ];
      const cols = `(id,user_id,organization_id,email,role_id,role,person_type,status,joined_at,created_at,updated_at)`;
      const vals = `($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
      const set = `email=EXCLUDED.email, role_id=EXCLUDED.role_id, role=EXCLUDED.role,
                   status=EXCLUDED.status, joined_at=EXCLUDED.joined_at, updated_at=EXCLUDED.updated_at`;
      const conflict = userId
        ? `ON CONFLICT (user_id, organization_id) WHERE user_id IS NOT NULL`
        : `ON CONFLICT (email, organization_id) WHERE email IS NOT NULL`;
      await ds.query(`INSERT INTO org_memberships ${cols} VALUES ${vals} ${conflict} DO UPDATE SET ${set}`, base);
      wrote++;
    }
    log('org_memberships', docs.length, wrote);
  }

  // ── 5. employees → enrich users + memberships ────────────────────────────────
  {
    let wrote = 0;
    let skipped = 0;
    for (const e of employees) {
      const userId = sid(e.userId);
      if (!userId) { skipped++; continue; }
      const title = e.designationId ? desigTitle.get(String(e.designationId)) ?? null : null;
      await ds.query(
        `UPDATE users SET
           date_of_birth=$2,
           skills=$3::jsonb,
           avatar=COALESCE(avatar,$4),
           phone_number=COALESCE(phone_number,$5),
           job_title=COALESCE($6, job_title),
           location=COALESCE(location,$7),
           timezone=COALESCE(timezone,$8)
         WHERE id=$1`,
        [userId, dt(e.dateOfBirth), JSON.stringify(e.skills ?? null), e.avatar ?? null,
         e.phone ?? null, title, e.location ?? null, e.timezone ?? null],
      );
      await ds.query(
        `UPDATE org_memberships SET
           employee_code=$3, employment_type=$4, joining_date=$5
         WHERE user_id=$1 AND organization_id=$2`,
        [userId, TARGET_ORG, e.employeeId ?? null, e.employmentType ?? null, dt(e.joiningDate)],
      );
      wrote++;
    }
    log('employees(enrich)', employees.length, wrote, skipped);
  }

  // ── 6. attendance (remap employeeId → userId; dedupe system rows per user+day) ─
  // The time-log tables had zero seed in the target org, so we DELETE-then-load
  // (org-scoped) for a deterministic, re-runnable result and to satisfy the
  // partial unique (org, employee, day) on entry_type='system'.
  {
    const docs = await col('attendances').find(orgFilter).toArray();
    const repo = ds.getRepository(AttendanceEntity);
    await ds.query(`DELETE FROM attendance WHERE organization_id = $1`, [TARGET_ORG]);
    let skipped = 0;
    const seenSystemDay = new Set<string>(); // `${userId}|${dayISO}` for system entries
    const mapped = docs.map((a) => {
      const uid = resolveUser(a.employeeId);
      if (!uid) { skipped++; return null; }
      const dd = dt(a.date);
      const entryType = String(a.entryType ?? 'system');
      if (entryType === 'system' && dd) {
        const key = `${uid}|${dd.toISOString()}`;
        if (seenSystemDay.has(key)) { skipped++; return null; }
        seenSystemDay.add(key);
      }
      return {
        id: sid(a._id)!,
        organizationId: TARGET_ORG,
        employeeId: uid,
        date: dt(a.date)!,
        checkInTime: dt(a.checkInTime),
        checkOutTime: dt(a.checkOutTime),
        checkInIP: a.checkInIP ?? null,
        checkOutIP: a.checkOutIP ?? null,
        checkInLocation: a.checkInLocation ?? null,
        checkOutLocation: a.checkOutLocation ?? null,
        workSegments: Array.isArray(a.workSegments) ? a.workSegments : [],
        totalWorkingHours: a.totalWorkingHours ?? null,
        effectiveWorkingHours: a.effectiveWorkingHours ?? null,
        overtimeHours: num(a.overtimeHours),
        status: String(a.status ?? 'present'),
        isLateArrival: bool(a.isLateArrival),
        lateByMinutes: num(a.lateByMinutes),
        isEarlyDeparture: bool(a.isEarlyDeparture),
        earlyByMinutes: num(a.earlyByMinutes),
        isNightShift: bool(a.isNightShift),
        appliedShiftPolicyId: sid(a.appliedShiftPolicyId),
        entryType: String(a.entryType ?? 'system'),
        approvalStatus: a.approvalStatus ?? null,
        approvedBy: sid(a.approvedBy),
        approvedAt: dt(a.approvedAt),
        rejectionReason: a.rejectionReason ?? null,
        notes: a.notes ?? null,
        missedCheckout: bool(a.missedCheckout),
        autoCheckedOut: bool(a.autoCheckedOut),
        missedCheckoutAt: dt(a.missedCheckoutAt),
        isDeleted: bool(a.isDeleted),
        createdBy: sid(a.createdBy),
        createdAt: dt(a.createdAt) ?? new Date(),
        updatedAt: dt(a.updatedAt) ?? new Date(),
      };
    });
    const rows = mapped.filter(Boolean) as any[];
    for (let i = 0; i < rows.length; i += 500) {
      await repo.createQueryBuilder().insert().values(rows.slice(i, i + 500))
        .orUpdate(repo.metadata.columns.map((c) => c.databaseName).filter((n) => n !== 'id'), ['id'])
        .execute();
    }
    log('attendance', docs.length, rows.length, skipped);
  }

  // ── 7. timesheets (userId direct) ────────────────────────────────────────────
  {
    const docs = await col('timesheets').find(orgFilter).toArray();
    const repo = ds.getRepository(TimesheetEntity);
    await ds.query(`DELETE FROM timesheets WHERE organization_id = $1`, [TARGET_ORG]);
    const rows = docs.map((t) => ({
      id: sid(t._id)!,
      organizationId: TARGET_ORG,
      userId: sid(t.userId)!,
      cadence: t.period?.type === 'monthly' ? 'monthly' : 'weekly',
      periodStart: dt(t.period?.startDate) ?? new Date(),
      periodEnd: dt(t.period?.endDate) ?? new Date(),
      entries: Array.isArray(t.entries) ? t.entries : [],
      totalHours: num(t.totalHours),
      status: String(t.status ?? 'draft'),
      submittedAt: dt(t.submittedAt),
      reviewedBy: sid(t.reviewedBy),
      reviewedAt: dt(t.reviewedAt),
      reviewNote: t.reviewComment ?? null,
      isDeleted: bool(t.isDeleted),
      createdAt: dt(t.createdAt) ?? new Date(),
      updatedAt: dt(t.updatedAt) ?? new Date(),
    })).filter((r) => r.userId);
    if (rows.length) {
      await repo.createQueryBuilder().insert().values(rows as any)
        .orUpdate(repo.metadata.columns.map((c) => c.databaseName).filter((n) => n !== 'id'), ['id'])
        .execute();
    }
    log('timesheets', docs.length, rows.length, docs.length - rows.length);
  }

  // ── 8. leaves (remap employeeId → userId) ────────────────────────────────────
  {
    const docs = await col('leaves').find(orgFilter).toArray();
    const repo = ds.getRepository(LeaveRequestEntity);
    await ds.query(`DELETE FROM leave_requests WHERE organization_id = $1`, [TARGET_ORG]);
    let skipped = 0;
    const rows = docs.map((l) => {
      const uid = resolveUser(l.employeeId);
      if (!uid) { skipped++; return null; }
      const half = l.halfDay && typeof l.halfDay === 'object' ? l.halfDay : null;
      return {
        id: sid(l._id)!,
        organizationId: TARGET_ORG,
        userId: uid,
        leaveType: String(l.leaveType ?? 'casual'),
        startDate: dt(l.startDate)!,
        endDate: dt(l.endDate)!,
        totalDays: num(l.totalDays),
        halfDay: bool(half?.enabled),
        halfDaySlot: half?.half ?? null,
        reason: String(l.reason ?? ''),
        status: String(l.status ?? 'pending'),
        reviewedBy: sid(l.approvedBy),
        reviewedAt: dt(l.approvedAt),
        reviewNote: l.rejectionReason ?? null,
        isDeleted: bool(l.isDeleted),
        createdAt: dt(l.createdAt) ?? new Date(),
        updatedAt: dt(l.updatedAt) ?? new Date(),
      };
    }).filter(Boolean) as any[];
    if (rows.length) {
      await repo.createQueryBuilder().insert().values(rows)
        .orUpdate(repo.metadata.columns.map((c) => c.databaseName).filter((n) => n !== 'id'), ['id'])
        .execute();
    }
    log('leave_requests', docs.length, rows.length, skipped);
  }

  // ── 9. leave balances (remap + dedupe by user+year) ──────────────────────────
  {
    const docs = await col('leavebalances').find(orgFilter).toArray();
    const repo = ds.getRepository(LeaveBalanceEntity);
    await ds.query(`DELETE FROM leave_balances WHERE organization_id = $1`, [TARGET_ORG]);
    let skipped = 0;
    const byUserYear = new Map<string, any>();
    for (const b of docs) {
      const uid = resolveUser(b.employeeId);
      if (!uid) { skipped++; continue; }
      const year = num(b.year, new Date().getFullYear());
      const balances = Array.isArray(b.balances)
        ? b.balances.map((x: any) => ({
            leaveType: x.leaveType, opening: num(x.opening), accrued: num(x.accrued),
            used: num(x.used), adjusted: num(x.adjusted), carriedForward: num(x.carriedForward),
            available: num(x.available),
          }))
        : [];
      byUserYear.set(`${uid}:${year}`, {
        id: sid(b._id)!, organizationId: TARGET_ORG, userId: uid, year, balances,
        createdAt: dt(b.createdAt) ?? new Date(), updatedAt: dt(b.updatedAt) ?? new Date(),
      });
    }
    const rows = [...byUserYear.values()];
    if (rows.length) {
      await repo.createQueryBuilder().insert().values(rows)
        .orUpdate(['organization_id', 'balances', 'updated_at'], ['user_id', 'year'])
        .execute();
    }
    log('leave_balances', docs.length, rows.length, skipped);
  }

  // ── 10. holidays ─────────────────────────────────────────────────────────────
  {
    const docs = await col('holidays').find(orgFilter).toArray();
    const repo = ds.getRepository(HolidayEntity);
    await ds.query(`DELETE FROM holidays WHERE organization_id = $1`, [TARGET_ORG]);
    const seenDate = new Set<string>(); // dedupe by day (unique (org, date))
    const rows = docs.map((h) => {
      const dd = dt(h.date);
      if (!dd || seenDate.has(dd.toISOString())) return null;
      seenDate.add(dd.toISOString());
      return {
        id: sid(h._id)!,
        organizationId: TARGET_ORG,
        date: dd,
        name: String(h.name ?? 'Holiday'),
        type: String(h.type ?? 'national'),
        description: h.description ?? null,
        year: num(h.year, new Date().getFullYear()),
        isDeleted: bool(h.isDeleted),
        createdBy: sid(h.createdBy),
        createdAt: dt(h.createdAt) ?? new Date(),
        updatedAt: dt(h.updatedAt) ?? new Date(),
      };
    }).filter(Boolean) as any[];
    if (rows.length) {
      await repo.createQueryBuilder().insert().values(rows as any)
        .orUpdate(repo.metadata.columns.map((c) => c.databaseName).filter((n) => n !== 'id'), ['id'])
        .execute();
    }
    log('holidays', docs.length, rows.length);
  }

  console.log('\n=== migration complete ===');
  console.table(report);
  await ds.destroy();
  await mc.close();
}

main().catch((e) => {
  console.error('MIGRATION FAILED:', e);
  process.exit(1);
});
