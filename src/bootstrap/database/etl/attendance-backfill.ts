/* eslint-disable no-console */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { MongoClient, ObjectId } from 'mongodb';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { AttendanceEntity } from '../../../modules/attendance/entities/attendance.entity';

/**
 * Attendance backfill — legacy Mongo → Postgres, ADD ONLY.
 *
 * While both apps are live, people still clock in/out on the legacy system. This
 * copies over the clock-ins/outs Postgres doesn't have yet:
 *
 *   • day has no row at all      → INSERT it (keeping the legacy `_id`)
 *   • day has a row with NO times → FILL its times/segments/hours/flags
 *   • day has a row WITH times    → SKIP and report (never overwrite real data)
 *
 * Nothing is ever deleted or overwritten, so it is safe to re-run daily until
 * cutover. Dry-run unless `--apply` is passed.
 *
 * Run:
 *   SRC_MONGODB_URI=... npx ts-node src/bootstrap/database/etl/attendance-backfill.ts [--apply] [--since 2026-09-01] [--legacy-org ID] [--target-org ID]
 */

const DEFAULT_LEGACY_ORG = '6600000000000000000000a0'; // Nugen IT Services (Mongo)
const DEFAULT_TARGET_ORG = '6a9fbcc377bf257f21e4b402'; // Nugen IT Services (Postgres)
const MONGO_DB = 'nugenova';

export interface LegacyAttendance {
  _id: unknown;
  employeeId?: unknown;
  date?: unknown;
  checkInTime?: unknown;
  checkOutTime?: unknown;
  checkInIP?: string | null;
  checkOutIP?: string | null;
  checkInLocation?: unknown;
  checkOutLocation?: unknown;
  workSegments?: unknown;
  totalWorkingHours?: number | null;
  effectiveWorkingHours?: number | null;
  overtimeHours?: number | null;
  status?: string;
  isLateArrival?: boolean;
  lateByMinutes?: number;
  isEarlyDeparture?: boolean;
  earlyByMinutes?: number;
  isNightShift?: boolean;
  entryType?: string;
  notes?: string | null;
  missedCheckout?: boolean;
  autoCheckedOut?: boolean;
  missedCheckoutAt?: unknown;
  isDeleted?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}
/** The Postgres row for that person+day, as far as this script cares. */
export interface ExistingRow { id: string; checkInTime: Date | null; checkOutTime: Date | null }
export type BackfillAction = 'insert' | 'fill' | 'skip-has-times' | 'skip-no-times' | 'skip-deleted';
export interface BackfillDecision { action: BackfillAction; reason?: string }

const dt = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v: unknown, def = 0): number => (Number.isFinite(Number(v)) ? Number(v) : def);
const bool = (v: unknown): boolean => v === true;
export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * What to do with one legacy row. Pure — the whole policy of this script lives
 * here (and is unit-tested): only rows that carry a real clock-in/out are worth
 * copying, and an existing row with times is never touched.
 */
export function decide(legacy: LegacyAttendance, existing: ExistingRow | null): BackfillDecision {
  if (bool(legacy.isDeleted)) return { action: 'skip-deleted' };
  const inAt = dt(legacy.checkInTime);
  const outAt = dt(legacy.checkOutTime);
  if (!inAt && !outAt) return { action: 'skip-no-times', reason: 'legacy row has no clock-in/out' };
  if (!existing) return { action: 'insert' };
  if (existing.checkInTime || existing.checkOutTime) {
    return { action: 'skip-has-times', reason: 'Postgres already has times for that day' };
  }
  return { action: 'fill' };
}

/** The clock-in/out columns copied from a legacy row (insert values / fill patch). */
export function attendanceFields(legacy: LegacyAttendance) {
  return {
    checkInTime: dt(legacy.checkInTime),
    checkOutTime: dt(legacy.checkOutTime),
    checkInIP: legacy.checkInIP ?? null,
    checkOutIP: legacy.checkOutIP ?? null,
    checkInLocation: (legacy.checkInLocation as any) ?? null,
    checkOutLocation: (legacy.checkOutLocation as any) ?? null,
    workSegments: Array.isArray(legacy.workSegments) ? (legacy.workSegments as any[]) : [],
    totalWorkingHours: legacy.totalWorkingHours ?? null,
    effectiveWorkingHours: legacy.effectiveWorkingHours ?? null,
    overtimeHours: num(legacy.overtimeHours),
    status: String(legacy.status ?? 'present'),
    isLateArrival: bool(legacy.isLateArrival),
    lateByMinutes: num(legacy.lateByMinutes),
    isEarlyDeparture: bool(legacy.isEarlyDeparture),
    earlyByMinutes: num(legacy.earlyByMinutes),
    isNightShift: bool(legacy.isNightShift),
    missedCheckout: bool(legacy.missedCheckout),
    autoCheckedOut: bool(legacy.autoCheckedOut),
    missedCheckoutAt: dt(legacy.missedCheckoutAt),
    notes: legacy.notes ?? null,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const legacyOrg = arg('legacy-org') ?? DEFAULT_LEGACY_ORG;
  const targetOrg = arg('target-org') ?? DEFAULT_TARGET_ORG;
  const since = arg('since') ? new Date(arg('since') as string) : null;

  const uri = process.env.SRC_MONGODB_URI;
  if (!uri) throw new Error('SRC_MONGODB_URI not set');
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

  console.log(`\nAttendance backfill  ${apply ? '(APPLY — writes to Postgres)' : '(dry run — no writes)'}`);
  console.log(`  mongo org ${legacyOrg} → postgres org ${targetOrg}`);
  console.log(`  postgres  ${dbUrl.replace(/\/\/([^:]+):[^@]+@/, '//$1:****@')}`);
  console.log(`  since     ${since ? since.toISOString() : '(all time)'}\n`);

  const mc = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await mc.connect();
  const mdb = mc.db(MONGO_DB);

  const ds = new DataSource({
    type: 'postgres',
    url: dbUrl,
    ssl: dbUrl && !isLocal ? { rejectUnauthorized: false } : false,
    entities: [AttendanceEntity],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  await ds.initialize();
  const repo = ds.getRepository(AttendanceEntity);

  try {
    const orgIds: unknown[] = [legacyOrg];
    try { orgIds.push(ObjectId.createFromHexString(legacyOrg)); } catch { /* not an ObjectId */ }

    // legacy employee _id → auth userId (Postgres attendance keys off the user).
    const employees = await mdb.collection('employees').find({}).project({ userId: 1, email: 1 }).toArray();
    const empToUser = new Map<string, string | null>(employees.map((e) => [String(e._id), e.userId ? String(e.userId) : null]));
    const empEmail = new Map<string, string>(employees.map((e) => [String(e._id), String(e.email ?? '')]));

    // Only members of the target org may receive rows.
    const members: { user_id: string }[] = await ds.query(
      `SELECT user_id FROM org_memberships WHERE organization_id = $1 AND user_id IS NOT NULL`, [targetOrg],
    );
    const memberIds = new Set(members.map((m) => m.user_id));

    const filter: Record<string, unknown> = { organizationId: { $in: orgIds } };
    if (since) filter.$or = [{ updatedAt: { $gte: since } }, { createdAt: { $gte: since } }, { date: { $gte: since } }];
    const docs = (await mdb.collection('attendances').find(filter).toArray()) as unknown as LegacyAttendance[];

    // Existing Postgres rows for this org, keyed by user+day.
    const existingRows: { id: string; employee_id: string; date: Date; check_in_time: Date | null; check_out_time: Date | null }[] =
      await ds.query(`SELECT id, employee_id, date, check_in_time, check_out_time FROM attendance WHERE organization_id = $1`, [targetOrg]);
    const byUserDay = new Map<string, ExistingRow>();
    const knownIds = new Set<string>();
    for (const r of existingRows) {
      knownIds.add(r.id);
      byUserDay.set(`${r.employee_id}|${dayKey(new Date(r.date))}`, { id: r.id, checkInTime: r.check_in_time, checkOutTime: r.check_out_time });
    }

    const counts: Record<string, number> = { insert: 0, fill: 0, 'skip-has-times': 0, 'skip-no-times': 0, 'skip-deleted': 0, 'skip-unknown-person': 0, 'skip-already-migrated': 0 };
    const changes: string[] = [];
    const conflicts: string[] = [];

    for (const legacy of docs) {
      const uid = empToUser.get(String(legacy.employeeId)) ?? null;
      const date = dt(legacy.date);
      if (!uid || !memberIds.has(uid) || !date) {
        counts['skip-unknown-person']++;
        continue;
      }
      if (knownIds.has(String(legacy._id))) { counts['skip-already-migrated']++; continue; }

      const day = dayKey(date);
      const existing = byUserDay.get(`${uid}|${day}`) ?? null;
      const { action, reason } = decide(legacy, existing);
      counts[action]++;
      const who = empEmail.get(String(legacy.employeeId)) || uid;
      const times = `${dt(legacy.checkInTime)?.toISOString().slice(11, 16) ?? '-'}→${dt(legacy.checkOutTime)?.toISOString().slice(11, 16) ?? '-'}`;

      if (action === 'skip-has-times') { conflicts.push(`  ${day}  ${who.padEnd(34)} legacy ${times}  (${reason})`); continue; }
      if (action !== 'insert' && action !== 'fill') continue;

      changes.push(`  ${action === 'insert' ? 'INSERT' : 'FILL  '} ${day}  ${who.padEnd(34)} ${times}`);
      if (!apply) continue;

      const fields = attendanceFields(legacy);
      if (action === 'insert') {
        await repo.insert({
          id: String(legacy._id), organizationId: targetOrg, employeeId: uid, date,
          entryType: String(legacy.entryType ?? 'system'), isDeleted: false,
          createdAt: dt(legacy.createdAt) ?? new Date(), updatedAt: dt(legacy.updatedAt) ?? new Date(),
          ...fields,
        } as any);
        byUserDay.set(`${uid}|${day}`, { id: String(legacy._id), checkInTime: fields.checkInTime, checkOutTime: fields.checkOutTime });
      } else if (existing) {
        await repo.update({ id: existing.id }, fields as any);
        byUserDay.set(`${uid}|${day}`, { id: existing.id, checkInTime: fields.checkInTime, checkOutTime: fields.checkOutTime });
      }
    }

    console.log(`legacy rows read: ${docs.length}\n`);
    if (changes.length) { console.log(`${apply ? 'Applied' : 'Would apply'} ${changes.length} change(s):`); changes.forEach((c) => console.log(c)); console.log(''); }
    else console.log('Nothing to add — Postgres already has every legacy clock-in/out.\n');
    if (conflicts.length) { console.log(`Left alone (Postgres already has times) — ${conflicts.length}:`); conflicts.slice(0, 20).forEach((c) => console.log(c)); if (conflicts.length > 20) console.log(`  … and ${conflicts.length - 20} more`); console.log(''); }
    console.log('summary:', Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join('  '));
    if (!apply) console.log('\nDry run only. Re-run with --apply to write these changes.');
  } finally {
    await ds.destroy();
    await mc.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('\nbackfill failed:', e); process.exit(1); });
}
