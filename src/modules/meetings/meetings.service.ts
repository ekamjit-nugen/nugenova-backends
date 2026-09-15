import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createHmac, randomBytes } from 'crypto';

import { MeetingEntity, MeetingParticipant, MeetingStatus } from './entities/meeting.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { NotifierService } from '../notification/notifier.service';
import { ActivityService } from '../activity/activity.service';
import { CreateMeetingDto, InstantMeetingDto, UpdateMeetingDto } from './dto';

/** Who is acting — org admins/owners can manage any meeting. */
export interface MeetingCaller {
  userId: string;
  isAdmin: boolean;
}

/** Everything the client needs to open the Jitsi room. */
export interface MeetingJoinConfig {
  meetingId: string;
  title: string;
  roomName: string;
  domain: string;
  jwt: string | null;
  displayName: string;
  email: string | null;
  moderator: boolean;
  lobbyEnabled: boolean;
  passcode: string | null;
  status: MeetingStatus;
}

const JOIN_TOKEN_TTL_SEC = 4 * 60 * 60; // 4h

/** Invitees see the join popup this long before a scheduled start. */
const INCOMING_EARLY_MS = 5 * 60 * 1000;
/** Assumed length of a meeting with no end time (and how long an undated one stays joinable). */
const INCOMING_DEFAULT_LENGTH_MS = 60 * 60 * 1000;

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    @InjectRepository(MeetingEntity)
    private readonly meetings: Repository<MeetingEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly config: ConfigService,
    private readonly notifier: NotifierService,
    private readonly activity: ActivityService,
  ) {}

  // ── Jitsi config (env-driven; meet.jit.si by default, JWT when self-hosted) ──
  private jitsiDomain(): string {
    return (this.config.get<string>('JITSI_DOMAIN') || 'meet.jit.si').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
  private jwtCreds(): { appId: string; secret: string; sub: string } | null {
    const appId = this.config.get<string>('JITSI_APP_ID');
    const secret = this.config.get<string>('JITSI_APP_SECRET');
    if (!appId || !secret) return null; // meet.jit.si / anonymous — no token
    return { appId, secret, sub: this.config.get<string>('JITSI_SUB') || appId };
  }

  /** Mint a Jitsi (prosody) JWT so self-hosted rooms authenticate the user and
   *  grant the host moderator rights. No-op (null) on an anonymous deployment. */
  private mintJwt(roomName: string, user: { id: string; name: string; email: string | null }, moderator: boolean): string | null {
    const creds = this.jwtCreds();
    if (!creds) return null;
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      aud: creds.appId,
      iss: creds.appId,
      sub: creds.sub,
      room: roomName,
      nbf: now - 10,
      exp: now + JOIN_TOKEN_TTL_SEC,
      context: {
        user: { id: user.id, name: user.name, email: user.email ?? undefined, moderator: moderator ? 'true' : 'false' },
      },
    };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signingInput = `${enc(header)}.${enc(payload)}`;
    const sig = createHmac('sha256', creds.secret).update(signingInput).digest('base64url');
    return `${signingInput}.${sig}`;
  }

  private newRoomName(orgId: string, title: string): string {
    const slug = (title || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'meeting';
    return `nxr-${orgId.slice(0, 6)}-${slug}-${randomBytes(9).toString('hex')}`;
  }

  private async userName(userId: string): Promise<string> {
    const u = await this.users.findOne({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } }).catch(() => null);
    return u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Someone' : 'Someone';
  }

  private async resolveParticipants(ids: string[]): Promise<MeetingParticipant[]> {
    const unique = [...new Set((ids ?? []).filter(Boolean))];
    if (!unique.length) return [];
    const users = await this.users.find({ where: { id: In(unique) } });
    return users.map((u) => ({ userId: u.id, name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Member' }));
  }

  private canAccess(m: MeetingEntity, caller: MeetingCaller): boolean {
    if (caller.isAdmin) return true;
    if (m.hostId === caller.userId) return true;
    return Array.isArray(m.participants) && m.participants.some((p) => p.userId === caller.userId);
  }

  private async requireMeeting(orgId: string, id: string, caller: MeetingCaller): Promise<MeetingEntity> {
    const m = await this.meetings.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!m) throw new NotFoundException('Meeting not found');
    if (!this.canAccess(m, caller)) throw new ForbiddenException('You do not have access to this meeting');
    return m;
  }

  private map(m: MeetingEntity, caller: MeetingCaller) {
    return {
      id: m.id,
      title: m.title,
      description: m.description,
      hostId: m.hostId,
      hostName: m.hostName,
      roomName: m.roomName,
      scheduledStart: m.scheduledStart,
      scheduledEnd: m.scheduledEnd,
      status: m.status,
      isInstant: m.isInstant,
      recurrence: m.recurrence ?? 'none',
      participants: m.participants ?? [],
      lobbyEnabled: m.lobbyEnabled,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      createdAt: m.createdAt,
      isHost: m.hostId === caller.userId,
      canManage: caller.isAdmin || m.hostId === caller.userId,
    };
  }

  private async notifyParticipants(m: MeetingEntity, actorId: string, type: string, title: string, body: string): Promise<void> {
    const recipients = (m.participants ?? []).map((p) => p.userId).filter((uid) => uid && uid !== actorId);
    await Promise.all(
      recipients.map((userId) =>
        this.notifier
          .notify({
            organizationId: m.organizationId,
            userId,
            actorId,
            type,
            title,
            body,
            data: { actionUrl: `/meetings/${m.id}`, meetingId: m.id },
            email: false,
            priority: 'normal',
          })
          .catch(() => undefined),
      ),
    );
  }

  // ── commands ──────────────────────────────────────────────────────────────

  async create(orgId: string, caller: MeetingCaller, dto: CreateMeetingDto) {
    const hostName = await this.userName(caller.userId);
    const participants = await this.resolveParticipants(dto.participantIds ?? []);
    const m = await this.meetings.save(this.meetings.create({
      organizationId: orgId,
      title: dto.title.trim() || 'Meeting',
      description: dto.description ?? null,
      hostId: caller.userId,
      hostName,
      roomName: this.newRoomName(orgId, dto.title),
      scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : null,
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : null,
      status: 'scheduled',
      isInstant: false,
      participants,
      lobbyEnabled: dto.lobbyEnabled ?? true,
      recurrence: dto.recurrence ?? 'none',
    }));
    const when = m.scheduledStart ? ` · ${new Date(m.scheduledStart).toLocaleString()}` : '';
    await this.notifyParticipants(m, caller.userId, 'meeting_invited', `Meeting invite: ${m.title}`, `${hostName} invited you to a meeting${when}.`);
    await this.activity.record({ organizationId: orgId, actorId: caller.userId, actorName: hostName, action: 'meeting.created', category: 'meetings', targetType: 'meeting', targetId: m.id, summary: `Scheduled meeting "${m.title}"` });
    return this.map(m, caller);
  }

  async instant(orgId: string, caller: MeetingCaller, dto: InstantMeetingDto) {
    const hostName = await this.userName(caller.userId);
    const participants = await this.resolveParticipants(dto.participantIds ?? []);
    const now = new Date();
    const m = await this.meetings.save(this.meetings.create({
      organizationId: orgId,
      title: (dto.title ?? '').trim() || `${hostName}'s meeting`,
      hostId: caller.userId,
      hostName,
      roomName: this.newRoomName(orgId, dto.title ?? 'instant'),
      status: 'live',
      isInstant: true,
      participants,
      lobbyEnabled: true,
      startedAt: now,
    }));
    await this.notifyParticipants(m, caller.userId, 'meeting_invited', `${hostName} started a meeting`, `${hostName} is inviting you to join now.`);
    await this.activity.record({ organizationId: orgId, actorId: caller.userId, actorName: hostName, action: 'meeting.started', category: 'meetings', targetType: 'meeting', targetId: m.id, summary: `Started an instant meeting "${m.title}"` });
    return { meeting: this.map(m, caller), join: this.buildJoin(m, caller, hostName) };
  }

  async list(orgId: string, caller: MeetingCaller) {
    const all = await this.meetings.find({ where: { organizationId: orgId, isDeleted: false }, order: { scheduledStart: 'DESC', createdAt: 'DESC' } });
    return all.filter((m) => this.canAccess(m, caller)).map((m) => this.map(m, caller));
  }

  /**
   * Meetings the caller has been invited to (not ones they host) that they can
   * join right now — drives the in-app "join meeting" popup. Joinable = live, or
   * scheduled and inside its window (from a few minutes before the start until the
   * end / a default length), or scheduled with no time and created recently.
   */
  async incoming(orgId: string, caller: MeetingCaller, now = new Date()) {
    const rows = await this.meetings.find({
      where: { organizationId: orgId, isDeleted: false, status: In(['live', 'scheduled']) },
      order: { createdAt: 'DESC' },
      take: 200,
    });
    const t = now.getTime();
    const joinable = (m: MeetingEntity) => {
      if (m.status === 'live') return true;
      if (m.scheduledStart) {
        const start = m.scheduledStart.getTime();
        const end = m.scheduledEnd?.getTime() ?? start + INCOMING_DEFAULT_LENGTH_MS;
        return t >= start - INCOMING_EARLY_MS && t <= end;
      }
      return t - (m.createdAt?.getTime() ?? 0) <= INCOMING_DEFAULT_LENGTH_MS;
    };
    return rows
      .filter((m) => m.hostId !== caller.userId && (m.participants ?? []).some((p) => p.userId === caller.userId))
      .filter(joinable)
      .map((m) => this.map(m, caller));
  }

  async get(orgId: string, caller: MeetingCaller, id: string) {
    return this.map(await this.requireMeeting(orgId, id, caller), caller);
  }

  async update(orgId: string, caller: MeetingCaller, id: string, dto: UpdateMeetingDto) {
    const m = await this.requireMeeting(orgId, id, caller);
    if (!(caller.isAdmin || m.hostId === caller.userId)) throw new ForbiddenException('Only the host can edit this meeting');
    if (m.status === 'ended' || m.status === 'cancelled') throw new BadRequestException('This meeting can no longer be edited');
    if (dto.title !== undefined) m.title = dto.title.trim() || m.title;
    if (dto.description !== undefined) m.description = dto.description;
    if (dto.scheduledStart !== undefined) m.scheduledStart = dto.scheduledStart ? new Date(dto.scheduledStart) : null;
    if (dto.scheduledEnd !== undefined) m.scheduledEnd = dto.scheduledEnd ? new Date(dto.scheduledEnd) : null;
    if (dto.lobbyEnabled !== undefined) m.lobbyEnabled = dto.lobbyEnabled;
    if (dto.participantIds !== undefined) m.participants = await this.resolveParticipants(dto.participantIds);
    const saved = await this.meetings.save(m);
    await this.notifyParticipants(saved, caller.userId, 'meeting_updated', `Meeting updated: ${saved.title}`, `${await this.userName(caller.userId)} updated a meeting you're invited to.`);
    return this.map(saved, caller);
  }

  async cancel(orgId: string, caller: MeetingCaller, id: string) {
    const m = await this.requireMeeting(orgId, id, caller);
    if (!(caller.isAdmin || m.hostId === caller.userId)) throw new ForbiddenException('Only the host can cancel this meeting');
    m.status = 'cancelled';
    const saved = await this.meetings.save(m);
    const actor = await this.userName(caller.userId);
    await this.notifyParticipants(saved, caller.userId, 'meeting_cancelled', `Meeting cancelled: ${saved.title}`, `${actor} cancelled a meeting.`);
    await this.activity.record({ organizationId: orgId, actorId: caller.userId, actorName: actor, action: 'meeting.cancelled', category: 'meetings', targetType: 'meeting', targetId: saved.id, summary: `Cancelled meeting "${saved.title}"` });
    return this.map(saved, caller);
  }

  async end(orgId: string, caller: MeetingCaller, id: string) {
    const m = await this.requireMeeting(orgId, id, caller);
    if (!(caller.isAdmin || m.hostId === caller.userId)) throw new ForbiddenException('Only the host can end this meeting');
    m.status = 'ended';
    m.endedAt = new Date();
    return this.map(await this.meetings.save(m), caller);
  }

  /** Add people to a meeting and notify them — the host can pull others into an
   *  ongoing call. Makes instant meetings group-ready. */
  async addParticipants(orgId: string, caller: MeetingCaller, id: string, userIds: string[]) {
    const m = await this.requireMeeting(orgId, id, caller);
    if (!(caller.isAdmin || m.hostId === caller.userId)) throw new ForbiddenException('Only the host can add people');
    if (m.status === 'ended' || m.status === 'cancelled') throw new BadRequestException('This meeting is over');
    const present = new Set((m.participants ?? []).map((p) => p.userId));
    present.add(m.hostId);
    const newIds = [...new Set((userIds ?? []).filter((uid) => uid && !present.has(uid)))];
    if (!newIds.length) return { meeting: this.map(m, caller), added: 0 };
    const resolved = await this.resolveParticipants(newIds);
    m.participants = [...(m.participants ?? []), ...resolved];
    const saved = await this.meetings.save(m);
    const hostName = await this.userName(caller.userId);
    await Promise.all(resolved.map((p) =>
      this.notifier.notify({
        organizationId: orgId, userId: p.userId, actorId: caller.userId,
        type: 'meeting_invited', title: `${hostName} added you to a meeting`,
        body: `You've been added to "${m.title}".`,
        data: { actionUrl: `/meetings/${m.id}`, meetingId: m.id }, email: false, priority: 'normal',
      }).catch(() => undefined),
    ));
    return { meeting: this.map(saved, caller), added: resolved.length };
  }

  /**
   * Auto-end abandoned live meetings so they don't linger in "Live now". A
   * recurring meeting's room persists (never auto-ended); a scheduled one ends a
   * short grace after its end time; anything else ends after a max live window.
   */
  async endStale(now = new Date()): Promise<number> {
    const MAX_LIVE_MS = 12 * 60 * 60 * 1000; // 12h
    const GRACE_MS = 30 * 60 * 1000; // 30m past scheduled end
    const live = await this.meetings.find({ where: { status: 'live', isDeleted: false } });
    const toEnd = live.filter((m) => {
      if (m.recurrence && m.recurrence !== 'none') return false; // standing room — keep
      if (m.scheduledEnd) return now.getTime() > m.scheduledEnd.getTime() + GRACE_MS;
      const started = (m.startedAt ?? m.createdAt).getTime();
      return now.getTime() - started > MAX_LIVE_MS;
    });
    if (!toEnd.length) return 0;
    for (const m of toEnd) { m.status = 'ended'; m.endedAt = now; }
    await this.meetings.save(toEnd);
    this.logger.log(`Auto-ended ${toEnd.length} stale live meeting(s)`);
    return toEnd.length;
  }

  /** Access-checked join: flips a scheduled meeting live and returns room config. */
  async join(orgId: string, caller: MeetingCaller, id: string): Promise<MeetingJoinConfig> {
    const m = await this.requireMeeting(orgId, id, caller);
    if (m.status === 'cancelled') throw new BadRequestException('This meeting was cancelled');
    if (m.status === 'ended') throw new BadRequestException('This meeting has ended');
    const name = await this.userName(caller.userId);
    if (m.status === 'scheduled') {
      // First join flips it live → tell everyone invited that it has started.
      m.status = 'live';
      if (!m.startedAt) m.startedAt = new Date();
      await this.meetings.save(m);
      await this.notifyParticipants(m, caller.userId, 'meeting_started', `${name} started the meeting`, `"${m.title}" has started — join now.`);
    }
    await this.activity.record({ organizationId: orgId, actorId: caller.userId, actorName: name, action: 'meeting.joined', category: 'meetings', targetType: 'meeting', targetId: m.id, summary: `Joined meeting "${m.title}"` });
    return this.buildJoin(m, caller, name);
  }

  private buildJoin(m: MeetingEntity, caller: MeetingCaller, displayName: string): MeetingJoinConfig {
    const moderator = caller.isAdmin || m.hostId === caller.userId;
    const email = null; // display-only; not required for the embed
    return {
      meetingId: m.id,
      title: m.title,
      roomName: m.roomName,
      domain: this.jitsiDomain(),
      jwt: this.mintJwt(m.roomName, { id: caller.userId, name: displayName, email }, moderator),
      displayName,
      email,
      moderator,
      lobbyEnabled: m.lobbyEnabled,
      passcode: m.passcode,
      status: m.status,
    };
  }
}
