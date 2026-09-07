import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Repository } from 'typeorm';

import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { ManualStatus, PresenceService, PresenceStatus } from './presence.service';
import {
  CHAT_MESSAGE_DELETED,
  CHAT_MESSAGE_NEW,
  CHAT_MESSAGE_UPDATED,
  ChatMessageDeletedEvent,
  ChatMessageEvent,
} from './chat-events';

/** Loose socket shape — we deliberately avoid fighting socket.io generics. */
interface ChatSocket {
  id: string;
  data: { userId?: string; orgId?: string | null };
  handshake: { auth?: { token?: string } };
  join(room: string): void;
  leave(room: string): void;
  emit(event: string, payload: unknown): void;
  to(room: string): { emit(event: string, payload: unknown): void };
  disconnect(close?: boolean): void;
}

/** Minimal server surface we use (room fan-out). */
interface ChatServer {
  to(room: string): { emit(event: string, payload: unknown): void };
}

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * ChatGateway — the Socket.IO `/chat` namespace. Owns:
 *   - handshake auth (JWT) + room joins (`org:<orgId>`, `user:<userId>`),
 *   - presence (via PresenceService) snapshot on connect + live `presence:update`
 *     fan-out to the org room,
 *   - conversation join/leave + typing relay,
 *   - live message delivery, driven by in-process events emitted by
 *     MessagesService (no direct dependency on the gateway → no circular import).
 *
 * Handler param types are intentionally loose (`ChatSocket`/`any`).
 */
@WebSocketGateway({
  namespace: 'chat',
  cors: { origin: CORS_ORIGINS, credentials: true },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: ChatServer;
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly presence: PresenceService,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
  ) {
    // The idle sweep marks users away off the socket loop; fan those out here.
    this.presence.registerChangeListener(({ userId, orgId, status }) => {
      this.broadcastPresence(orgId, userId, status);
    });
  }

  // ── connection lifecycle ────────────────────────────────────────────────

  async handleConnection(client: ChatSocket): Promise<void> {
    try {
      const token = client.handshake?.auth?.token;
      if (!token) {
        client.disconnect();
        return;
      }

      let payload: any;
      try {
        payload = this.jwt.verify(token);
      } catch {
        client.disconnect();
        return;
      }

      const userId: string | undefined = payload?.sub;
      const orgId: string | null = payload?.organizationId ?? null;
      if (!userId) {
        client.disconnect();
        return;
      }

      client.data.userId = userId;
      client.data.orgId = orgId;

      client.join(`user:${userId}`);
      if (orgId) client.join(`org:${orgId}`);

      const wasOnline = this.presence.isOnline(userId);
      this.presence.onConnect(userId, orgId);
      // Announce online only on the offline/away → online transition.
      if (orgId && !wasOnline) this.broadcastPresence(orgId, userId, 'online');

      // Send the current org roster's presence to just this socket.
      if (orgId) {
        const memberIds = await this.orgMemberIds(orgId);
        const statuses = await this.presence.snapshotForOrg(orgId, memberIds);
        client.emit('presence:snapshot', { statuses });
      } else {
        client.emit('presence:snapshot', { statuses: [] });
      }
    } catch (err) {
      this.logger.warn(`handleConnection failed: ${String(err)}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: ChatSocket): Promise<void> {
    try {
      const userId = client.data?.userId;
      const orgId = client.data?.orgId ?? null;
      if (!userId) return;
      this.presence.onDisconnect(userId);
      if (!this.presence.isOnline(userId) && orgId) {
        // offline, or on_holiday if the (now disconnected) user is on leave today.
        const status = await this.presence.resolveStatus(userId, orgId);
        this.broadcastPresence(orgId, userId, status);
      }
    } catch (err) {
      this.logger.warn(`handleDisconnect failed: ${String(err)}`);
    }
  }

  // ── conversation rooms ──────────────────────────────────────────────────

  @SubscribeMessage('conversation:join')
  handleConversationJoin(client: ChatSocket, data: { conversationId?: string }): void {
    const conversationId = data?.conversationId;
    if (!client.data?.userId || !conversationId) return;
    client.join(conversationId);
  }

  @SubscribeMessage('conversation:leave')
  handleConversationLeave(client: ChatSocket, data: { conversationId?: string }): void {
    const conversationId = data?.conversationId;
    if (!conversationId) return;
    client.leave(conversationId);
  }

  // ── typing ──────────────────────────────────────────────────────────────

  @SubscribeMessage('typing:start')
  handleTypingStart(client: ChatSocket, data: { conversationId?: string }): void {
    this.relayTyping(client, data?.conversationId, true);
  }

  @SubscribeMessage('typing:stop')
  handleTypingStop(client: ChatSocket, data: { conversationId?: string }): void {
    this.relayTyping(client, data?.conversationId, false);
  }

  private relayTyping(
    client: ChatSocket,
    conversationId: string | undefined,
    isTyping: boolean,
  ): void {
    const userId = client.data?.userId;
    if (!userId || !conversationId) return;
    // `client.to(...)` excludes the sender — never echo typing back to yourself.
    client.to(conversationId).emit('typing', { conversationId, userId, isTyping });
  }

  // ── presence heartbeats ─────────────────────────────────────────────────

  @SubscribeMessage('presence:active')
  handlePresenceActive(client: ChatSocket): void {
    const userId = client.data?.userId;
    const orgId = client.data?.orgId ?? null;
    if (!userId) return;
    const wasOnline = this.presence.isOnline(userId);
    this.presence.heartbeat(userId, orgId);
    // Only broadcast when this actually flips them back to online (was away).
    if (orgId && !wasOnline) this.broadcastPresence(orgId, userId, 'online');
  }

  @SubscribeMessage('presence:away')
  handlePresenceAway(client: ChatSocket): void {
    const userId = client.data?.userId;
    const orgId = client.data?.orgId ?? null;
    if (!userId) return;
    this.presence.setAway(userId, orgId);
    if (orgId) this.broadcastPresence(orgId, userId, 'away');
  }

  /**
   * Explicit presence pick from the status picker. Body:
   *   - `{ status: 'active'|'away'|'busy'|'offline' }` — 'active' clears the
   *     override (resume auto), the rest set a sticky override that wins while
   *     connected. Any of these also clears a self-declared holiday window.
   *   - `{ status: 'on_holiday', from, until }` — persist a holiday window (dates
   *     as 'YYYY-MM-DD' or ISO). It wins over everything until it expires and is
   *     shown to everyone. Broadcasts the freshly resolved status.
   */
  @SubscribeMessage('presence:set')
  async handlePresenceSet(
    client: ChatSocket,
    data: { status?: string; from?: string; until?: string },
  ): Promise<void> {
    const userId = client.data?.userId;
    const orgId = client.data?.orgId ?? null;
    if (!userId) return;

    if (data?.status === 'on_holiday') {
      const from = this.parseDay(data?.from, false);
      const until = this.parseDay(data?.until, true);
      if (!from || !until || until.getTime() < from.getTime()) return; // need a valid range
      await this.presence.setHoliday(userId, from, until);
      // Drop any stale in-memory override so the holiday resolves cleanly (and
      // nothing odd resurfaces the moment the window later expires).
      this.presence.setManual(userId, 'active', orgId);
    } else {
      const status = this.clampManualStatus(data?.status);
      if (!status) return; // ignore unknown/garbage values
      await this.presence.clearHoliday(userId);
      this.presence.setManual(userId, status, orgId);
    }

    if (orgId) {
      const resolved = await this.presence.resolveStatus(userId, orgId);
      this.broadcastPresence(orgId, userId, resolved);
    }
  }

  /** Validate/clamp an inbound manual status; null if not one of the four. */
  private clampManualStatus(value: unknown): ManualStatus | null {
    return value === 'active' ||
      value === 'away' ||
      value === 'busy' ||
      value === 'offline'
      ? value
      : null;
  }

  /**
   * Parse a day boundary for a holiday window. Accepts 'YYYY-MM-DD' (from the
   * date picker) — start-of-day for `from`, end-of-day for `until` — or a full
   * ISO timestamp. Returns null on anything unparseable. UTC.
   */
  private parseDay(value: unknown, endOfDay: boolean): Date | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const iso = isDateOnly
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : value;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  // ── message fan-out (driven by MessagesService via the event bus) ─────────

  @OnEvent(CHAT_MESSAGE_NEW)
  handleMessageNew(payload: ChatMessageEvent): void {
    if (!payload?.conversationId || !this.server) return;
    this.server.to(payload.conversationId).emit('message:new', { message: payload.message });
  }

  @OnEvent(CHAT_MESSAGE_UPDATED)
  handleMessageUpdated(payload: ChatMessageEvent): void {
    if (!payload?.conversationId || !this.server) return;
    this.server
      .to(payload.conversationId)
      .emit('message:updated', { message: payload.message });
  }

  @OnEvent(CHAT_MESSAGE_DELETED)
  handleMessageDeleted(payload: ChatMessageDeletedEvent): void {
    if (!payload?.conversationId || !this.server) return;
    this.server.to(payload.conversationId).emit('message:deleted', {
      messageId: payload.messageId,
      conversationId: payload.conversationId,
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private broadcastPresence(
    orgId: string,
    userId: string,
    status: PresenceStatus,
  ): void {
    if (!this.server || !orgId) return;
    this.server.to(`org:${orgId}`).emit('presence:update', { userId, status });
  }

  /** Active org members with a real auth user id (presence roster). */
  private async orgMemberIds(orgId: string): Promise<string[]> {
    const rows = await this.memberships.find({
      where: { organizationId: orgId, status: 'active' },
      select: { userId: true },
    });
    return rows.map((r) => r.userId).filter((id): id is string => !!id);
  }
}
