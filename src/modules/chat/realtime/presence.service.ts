import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';
import { UserEntity } from '../../auth/entities/user.entity';

/** Presence states shared with the frontend (see the socket contract). */
export type PresenceStatus =
  | 'online'
  | 'away'
  | 'busy'
  | 'offline'
  | 'on_holiday';

/**
 * A manual presence override the user sets explicitly (`presence:set`):
 *   - 'active'  → clear the override, resume automatic presence (heartbeat).
 *   - 'away' | 'busy' | 'offline' → a sticky override that wins while connected.
 */
export type ManualStatus = 'active' | 'away' | 'busy' | 'offline';

/** The sticky override values actually stored on an entry. */
type ManualOverride = 'away' | 'busy' | 'offline' | null;

/** The approved-leave status value (see leave-catalog LeaveStatus). */
const LEAVE_APPROVED = 'approved';

interface PresenceEntry {
  socketCount: number;
  lastActiveAt: number;
  away: boolean;
  /**
   * Sticky manual override set via `setManual`. When non-null and the user is
   * connected it wins over the automatic online/away derivation. In-memory only
   * and cleared when the user fully disconnects (socketCount hits 0).
   */
  manual: ManualOverride;
  /** Last-seen org for this user, so the sweep knows which room to fan out to. */
  orgId: string | null;
}

/** Called by the gateway to fan a swept status change out to `org:<orgId>`. */
export type PresenceChangeListener = (change: {
  userId: string;
  orgId: string;
  status: PresenceStatus;
}) => void;

/**
 * PresenceService — single-node, in-memory presence for the chat realtime layer.
 *
 * Tracks, per user, how many live sockets they have, when they were last active,
 * whether they've gone `away` (idle), and any explicit manual override. Status
 * is derived, with a manual override winning while the user is connected:
 *   - socketCount > 0 && manual  → busy | away | offline (the override)
 *   - socketCount > 0 && !away    → online
 *   - socketCount > 0 &&  away    → away
 *   - socketCount === 0          → on_holiday (approved leave spanning now) else offline
 *
 * A periodic sweep flips still-connected-but-idle users to `away` after
 * `AWAY_AFTER_MS` with no heartbeat and notifies the registered listener so the
 * gateway can broadcast the change. The sweep never touches a user who has set a
 * manual override (it won't flip a manual `busy`/`offline` to `away`).
 *
 * LIMITATION: this state lives in one process. A multi-node deployment would
 * need a shared store (e.g. a Redis socket.io adapter + shared presence) — see
 * PLAYBOOK. For the single dev/prod node today, in-memory is correct and cheap.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly presence = new Map<string, PresenceEntry>();
  private listener: PresenceChangeListener | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  /** Idle window with no heartbeat after which a connected user goes `away`. */
  static readonly AWAY_AFTER_MS = 5 * 60 * 1000;
  /** How often the idle sweep runs. */
  static readonly SWEEP_INTERVAL_MS = 60 * 1000;

  constructor(
    @InjectRepository(LeaveRequestEntity)
    private readonly leaveRepo: Repository<LeaveRequestEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {
    this.sweepTimer = setInterval(
      () => this.sweepAway(),
      PresenceService.SWEEP_INTERVAL_MS,
    );
    // Don't keep the event loop (or a Jest worker) alive on this timer.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** The gateway registers here to receive swept `away` transitions. */
  registerChangeListener(fn: PresenceChangeListener): void {
    this.listener = fn;
  }

  // ── connection lifecycle ────────────────────────────────────────────────

  /** A new socket connected for this user. First socket clears any `away`. */
  onConnect(userId: string, orgId?: string | null): void {
    const e = this.presence.get(userId);
    if (e) {
      e.socketCount += 1;
      e.lastActiveAt = Date.now();
      e.away = false;
      if (orgId) e.orgId = orgId;
    } else {
      this.presence.set(userId, {
        socketCount: 1,
        lastActiveAt: Date.now(),
        away: false,
        manual: null,
        orgId: orgId ?? null,
      });
    }
  }

  /** A socket for this user disconnected. At zero the user is offline. */
  onDisconnect(userId: string): void {
    const e = this.presence.get(userId);
    if (!e) return;
    e.socketCount = Math.max(0, e.socketCount - 1);
    if (e.socketCount === 0) {
      // Keep the entry (holds orgId/lastActiveAt) but they're no longer online.
      // A manual override is per-session and does not survive a full disconnect.
      e.away = false;
      e.manual = null;
    }
  }

  /** Heartbeat (`presence:active`): mark active + clear `away`. */
  heartbeat(userId: string, orgId?: string | null): void {
    const e = this.presence.get(userId);
    if (e) {
      e.lastActiveAt = Date.now();
      e.away = false;
      if (orgId) e.orgId = orgId;
    } else {
      // A heartbeat with no known socket still counts as one live client.
      this.presence.set(userId, {
        socketCount: 1,
        lastActiveAt: Date.now(),
        away: false,
        manual: null,
        orgId: orgId ?? null,
      });
    }
  }

  /** Idle/auto away (`presence:away`). Does not set a sticky manual override. */
  setAway(userId: string, orgId?: string | null): void {
    const e = this.presence.get(userId);
    if (e) {
      e.away = true;
      if (orgId) e.orgId = orgId;
    } else {
      this.presence.set(userId, {
        socketCount: 1,
        lastActiveAt: Date.now(),
        away: true,
        manual: null,
        orgId: orgId ?? null,
      });
    }
  }

  /**
   * Explicit manual presence override (`presence:set`).
   *   - 'active'  → clear any override and resume automatic presence, marking the
   *                 user active (equivalent to a heartbeat).
   *   - 'away' | 'busy' | 'offline' → set a sticky override that wins over the
   *                 automatic derivation while the user is connected. The idle
   *                 sweep will not disturb it.
   * The override is in-memory only and is cleared on full disconnect.
   */
  setManual(userId: string, status: ManualStatus, orgId?: string | null): void {
    const e = this.presence.get(userId);
    if (e) {
      if (orgId) e.orgId = orgId;
      if (status === 'active') {
        // Resume automatic presence + treat as a fresh heartbeat.
        e.manual = null;
        e.away = false;
        e.lastActiveAt = Date.now();
      } else {
        e.manual = status;
      }
      return;
    }
    // No known entry yet: a manual set still counts as one live client.
    this.presence.set(userId, {
      socketCount: 1,
      lastActiveAt: Date.now(),
      away: false,
      manual: status === 'active' ? null : status,
      orgId: orgId ?? null,
    });
  }

  // ── queries ─────────────────────────────────────────────────────────────

  /**
   * "Actively online" — has a live socket AND is not away. This is the gate for
   * away-suppressed mention notifications: an online recipient sees the mention
   * live, so we don't also notify them; away/offline/on-holiday users ARE
   * notified.
   */
  isOnline(userId: string): boolean {
    const e = this.presence.get(userId);
    return !!e && e.socketCount > 0 && !e.away;
  }

  // ── self-declared holiday (status picker) ───────────────────────────────
  // A user can mark themselves "On holiday" for a date range from the chat status
  // picker. Unlike a manual busy/away override (in-memory, per-session), this is
  // persisted on the user's `preferences` jsonb so it survives disconnects, shows
  // to everyone, and auto-expires when the window ends — no migration needed.

  /** Persist a self-declared holiday window [from, until]. */
  async setHoliday(userId: string, from: Date, until: Date): Promise<void> {
    try {
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user) return;
      user.preferences = {
        ...(user.preferences ?? {}),
        chatHoliday: { from: from.toISOString(), until: until.toISOString() },
      };
      await this.userRepo.save(user);
    } catch (err) {
      this.logger.error(`setHoliday failed (user=${userId}): ${String(err)}`);
    }
  }

  /** Remove any self-declared holiday window (resume normal presence). */
  async clearHoliday(userId: string): Promise<void> {
    try {
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user?.preferences || !('chatHoliday' in user.preferences)) return;
      const prefs = { ...user.preferences };
      delete (prefs as Record<string, unknown>).chatHoliday;
      user.preferences = prefs;
      await this.userRepo.save(user);
    } catch (err) {
      this.logger.error(`clearHoliday failed (user=${userId}): ${String(err)}`);
    }
  }

  /** Whether `now` falls inside the user's self-declared holiday window. */
  private async isSelfHolidayNow(userId: string): Promise<boolean> {
    try {
      const user = await this.userRepo.findOne({
        where: { id: userId },
        select: ['id', 'preferences'],
      });
      const h = user?.preferences?.['chatHoliday'] as
        | { from?: string; until?: string }
        | undefined;
      if (!h?.from || !h?.until) return false;
      const now = Date.now();
      return now >= new Date(h.from).getTime() && now <= new Date(h.until).getTime();
    } catch (err) {
      this.logger.error(`holiday lookup failed (user=${userId}): ${String(err)}`);
      return false;
    }
  }

  /** Resolve the full status, consulting approved leave when not connected. */
  async resolveStatus(userId: string, orgId: string): Promise<PresenceStatus> {
    // A self-declared holiday window wins over everything (shown even while the
    // user is actively connected) for as long as the window is active.
    if (await this.isSelfHolidayNow(userId)) return 'on_holiday';

    const e = this.presence.get(userId);
    if (e && e.socketCount > 0) {
      // Manual override wins while connected (busy/away/appear-offline).
      if (e.manual === 'busy') return 'busy';
      if (e.manual === 'away') return 'away';
      if (e.manual === 'offline') return 'offline';
      return e.away ? 'away' : 'online';
    }
    // Not connected → offline, unless on approved leave spanning today.
    // (A disconnected user's manual override is already cleared.)
    if (await this.isOnApprovedLeaveToday(userId, orgId)) return 'on_holiday';
    return 'offline';
  }

  /** Resolve statuses for a set of org members (for the connect snapshot). */
  async snapshotForOrg(
    orgId: string,
    userIds: string[],
  ): Promise<{ userId: string; status: PresenceStatus }[]> {
    const unique = [...new Set(userIds)];
    const out: { userId: string; status: PresenceStatus }[] = [];
    for (const userId of unique) {
      out.push({ userId, status: await this.resolveStatus(userId, orgId) });
    }
    return out;
  }

  // ── idle sweep ──────────────────────────────────────────────────────────

  /**
   * Flip still-connected users who've gone quiet to `away` and notify the
   * listener. `now` is injectable for tests. Fail-safe: never throws.
   */
  sweepAway(now: number = Date.now()): void {
    try {
      for (const [userId, e] of this.presence) {
        if (
          e.socketCount > 0 &&
          !e.away &&
          !e.manual && // never override an explicit manual status
          now - e.lastActiveAt > PresenceService.AWAY_AFTER_MS
        ) {
          e.away = true;
          if (e.orgId && this.listener) {
            this.listener({ userId, orgId: e.orgId, status: 'away' });
          }
        }
      }
    } catch (err) {
      this.logger.error(`presence sweep failed: ${String(err)}`);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async isOnApprovedLeaveToday(
    userId: string,
    orgId: string,
  ): Promise<boolean> {
    try {
      if (!orgId) return false;
      const now = new Date();
      const count = await this.leaveRepo.count({
        where: {
          organizationId: orgId,
          userId,
          status: LEAVE_APPROVED,
          startDate: LessThanOrEqual(now),
          endDate: MoreThanOrEqual(now),
        },
      });
      return count > 0;
    } catch (err) {
      // Fail-safe: a leave-lookup error must not break presence resolution.
      this.logger.error(`leave lookup failed (user=${userId}): ${String(err)}`);
      return false;
    }
  }
}
