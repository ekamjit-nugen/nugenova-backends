import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';

/** Presence states shared with the frontend (see the socket contract). */
export type PresenceStatus = 'online' | 'away' | 'offline' | 'on_holiday';

/** The approved-leave status value (see leave-catalog LeaveStatus). */
const LEAVE_APPROVED = 'approved';

interface PresenceEntry {
  socketCount: number;
  lastActiveAt: number;
  away: boolean;
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
 * and whether they've gone `away` (manual or idle). Status is derived:
 *   - socketCount > 0 && !away  → online
 *   - socketCount > 0 &&  away   → away
 *   - socketCount === 0         → on_holiday (approved leave spanning now) else offline
 *
 * A periodic sweep flips still-connected-but-idle users to `away` after
 * `AWAY_AFTER_MS` with no heartbeat and notifies the registered listener so the
 * gateway can broadcast the change.
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
      e.away = false;
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
        orgId: orgId ?? null,
      });
    }
  }

  /** Manual/idle away (`presence:away`). */
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
        orgId: orgId ?? null,
      });
    }
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

  /** Resolve the full status, consulting approved leave when not connected. */
  async resolveStatus(userId: string, orgId: string): Promise<PresenceStatus> {
    const e = this.presence.get(userId);
    if (e && e.socketCount > 0) {
      return e.away ? 'away' : 'online';
    }
    // Not connected → offline, unless on approved leave spanning today.
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
