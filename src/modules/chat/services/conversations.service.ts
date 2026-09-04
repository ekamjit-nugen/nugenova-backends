import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ConversationEntity, Participant } from '../entities/conversation.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

/**
 * ConversationsService — direct/group/channel/self threads. Ported from the
 * Mongo chat-service `ConversationsService`, Mongoose Model → TypeORM
 * Repository.
 *
 * ISOLATION (the #1 rule): every read AND write is scoped to `organizationId`
 * AND the caller's `userId`. A conversation is only ever loaded through
 * `loadForMember`, which requires the caller to be a participant; cross-org and
 * cross-user reads are impossible by construction.
 *
 * Deferred vs the monolith (see PLAYBOOK.md): managed client channels, the
 * shared cache layer, the CONVERSATION_CREATED socket announcement, and the
 * default-channel auto-join. None of those change the core contract.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
  ) {}

  /**
   * The people the caller can start a conversation with / @mention: every ACTIVE
   * member of the caller's org who has a linked user account, minus the caller.
   * Available to ANY authenticated member (not admin-gated like `/org/members`),
   * since messaging a colleague is not an admin action. Always scoped to the
   * caller's org.
   */
  async directory(orgId: string, meId: string) {
    const rows = await this.memberships.find({
      where: { organizationId: orgId, status: 'active' },
      order: { createdAt: 'ASC' },
    });
    const messageable = rows.filter((m) => m.userId && m.userId !== meId);
    const names = await this.nameMap(messageable.map((m) => m.userId as string));
    return messageable.map((m) => {
      const n = names.get(m.userId as string);
      return {
        membershipId: m.id,
        userId: m.userId,
        email: m.email,
        firstName: n?.firstName ?? null,
        lastName: n?.lastName ?? null,
        role: m.role,
        status: m.status,
      };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private nowIso(): string {
    return new Date().toISOString();
  }

  private newParticipant(userId: string, role = 'member'): Participant {
    const now = this.nowIso();
    return {
      userId,
      role,
      memberStatus: 'active',
      joinedAt: now,
      lastReadAt: now,
      lastReadMessageId: null,
      muted: false,
      mutedUntil: null,
      isPinned: false,
      isStarred: false,
      notifyPreference: 'all',
    };
  }

  /** Keep the denormalised participantIds column in lock-step with participants. */
  private syncParticipantIds(conv: ConversationEntity): void {
    conv.participantIds = conv.participants.map((p) => p.userId);
  }

  /**
   * Load a conversation the caller is allowed to see: same org AND a
   * participant. Anything else is a 404 (not found) or 403 (found but not a
   * member) — never a leak of another org's/user's thread.
   */
  private async loadForMember(
    conversationId: string,
    orgId: string,
    userId: string,
  ): Promise<ConversationEntity> {
    const conv = await this.conversations.findOne({
      where: { id: conversationId, isDeleted: false },
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    // Cross-org access is a not-found (don't confirm the row exists elsewhere).
    if (conv.organizationId && orgId && conv.organizationId !== orgId) {
      throw new NotFoundException('Conversation not found');
    }
    if (!conv.participants.some((p) => p.userId === userId)) {
      throw new ForbiddenException('You are not a participant of this conversation');
    }
    return conv;
  }

  /** Resolve firstName/lastName for a set of user ids in one query. */
  private async nameMap(
    userIds: string[],
  ): Promise<Map<string, { firstName: string; lastName: string }>> {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    const map = new Map<string, { firstName: string; lastName: string }>();
    if (!ids.length) return map;
    const rows = await this.users.find({
      where: { id: In(ids) },
      select: ['id', 'firstName', 'lastName'],
    });
    for (const u of rows) {
      map.set(u.id, { firstName: u.firstName ?? '', lastName: u.lastName ?? '' });
    }
    return map;
  }

  /**
   * Shape a conversation for the client: preserve the Mongo `_id` shape as `id`
   * (and keep `_id` too for legacy FE readers), enrich each participant with
   * their name, surface the viewer's pin/star flags, and derive a DM's title
   * from the OTHER participant when `name` is null.
   */
  private present(
    conv: ConversationEntity,
    viewerId: string,
    names: Map<string, { firstName: string; lastName: string }>,
  ): Record<string, unknown> {
    const participants = conv.participants.map((p) => {
      const n = names.get(p.userId);
      return { ...p, firstName: n?.firstName ?? '', lastName: n?.lastName ?? '' };
    });
    const me = participants.find((p) => p.userId === viewerId);

    let name = conv.name;
    if (!name && (conv.type === 'direct' || conv.type === 'self')) {
      const other = participants.find((p) => p.userId !== viewerId) ?? participants[0];
      if (other) {
        const full = `${other.firstName ?? ''} ${other.lastName ?? ''}`.trim();
        if (full) name = full;
      }
    }

    return {
      id: conv.id,
      _id: conv.id,
      organizationId: conv.organizationId,
      type: conv.type,
      channelType: conv.channelType,
      name,
      description: conv.description,
      avatar: conv.avatar,
      icon: conv.icon,
      topic: conv.topic,
      categoryId: conv.categoryId,
      clientId: conv.clientId,
      participants,
      lastMessage: conv.lastMessage,
      messageCount: conv.messageCount,
      settings: conv.settings,
      isArchived: conv.isArchived,
      createdBy: conv.createdBy,
      isDeleted: conv.isDeleted,
      pinned: !!me?.isPinned,
      starred: !!me?.isStarred,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    };
  }

  private async view(conv: ConversationEntity, viewerId: string) {
    const names = await this.nameMap(conv.participants.map((p) => p.userId));
    return this.present(conv, viewerId, names);
  }

  // ── create ────────────────────────────────────────────────────────────────

  async createDirect(userId1: string, userId2: string, orgId: string) {
    // A DM must be between two DISTINCT users — guard the self-conversation.
    if (!userId1 || !userId2 || userId1 === userId2) {
      throw new BadRequestException('A direct conversation needs two different people.');
    }

    // Find an existing 2-person direct thread with exactly this pair in this org.
    const candidates = await this.conversations
      .createQueryBuilder('c')
      .where('c.type = :type', { type: 'direct' })
      .andWhere('c.is_deleted = false')
      .andWhere('c.organization_id = :orgId', { orgId })
      .andWhere(':u1 = ANY(c.participant_ids)', { u1: userId1 })
      .andWhere(':u2 = ANY(c.participant_ids)', { u2: userId2 })
      .getMany();
    const existing = candidates.find((c) => c.participantIds.length === 2);
    if (existing) return this.view(existing, userId1);

    const conv = this.conversations.create({
      type: 'direct',
      name: null,
      organizationId: orgId || null,
      participants: [this.newParticipant(userId1), this.newParticipant(userId2)],
      createdBy: userId1,
    });
    this.syncParticipantIds(conv);
    const saved = await this.conversations.save(conv);
    this.logger.log(`Direct conversation created: ${saved.id}`);
    return this.view(saved, userId1);
  }

  async createGroup(
    name: string,
    description: string | undefined,
    memberIds: string[],
    createdBy: string,
    orgId: string,
  ) {
    const ids = Array.from(new Set([createdBy, ...(memberIds ?? [])]));
    const conv = this.conversations.create({
      type: 'group',
      name,
      description: description || null,
      organizationId: orgId || null,
      participants: ids.map((id) =>
        this.newParticipant(id, id === createdBy ? 'owner' : 'member'),
      ),
      createdBy,
    });
    this.syncParticipantIds(conv);
    const saved = await this.conversations.save(conv);
    this.logger.log(`Group created: ${saved.id} - ${name}`);
    return this.view(saved, createdBy);
  }

  async createChannel(
    name: string,
    description: string | undefined,
    createdBy: string,
    orgId: string,
    memberIds?: string[],
    channelType = 'public',
    topic?: string,
    categoryId?: string,
  ) {
    const ids = memberIds
      ? Array.from(new Set([createdBy, ...memberIds]))
      : [createdBy];
    const conv = this.conversations.create({
      type: 'channel',
      channelType,
      name,
      description: description || null,
      topic: topic || null,
      categoryId: categoryId || null,
      organizationId: orgId || null,
      participants: ids.map((id) =>
        this.newParticipant(id, id === createdBy ? 'owner' : 'member'),
      ),
      createdBy,
    });
    this.syncParticipantIds(conv);
    const saved = await this.conversations.save(conv);
    this.logger.log(`Channel created: ${saved.id} - ${name} (${channelType})`);
    return this.view(saved, createdBy);
  }

  async getOrCreateSelf(userId: string, orgId: string) {
    const existing = await this.conversations
      .createQueryBuilder('c')
      .where('c.type = :type', { type: 'self' })
      .andWhere('c.is_deleted = false')
      .andWhere('c.organization_id = :orgId', { orgId })
      .andWhere(':me = ANY(c.participant_ids)', { me: userId })
      .getOne();
    if (existing) return this.view(existing, userId);

    const conv = this.conversations.create({
      type: 'self',
      name: 'Notes to Self',
      organizationId: orgId || null,
      participants: [this.newParticipant(userId, 'owner')],
      createdBy: userId,
    });
    this.syncParticipantIds(conv);
    const saved = await this.conversations.save(conv);
    this.logger.log(`Self conversation created for ${userId}`);
    return this.view(saved, userId);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async getMyConversations(userId: string, orgId: string, opts: { starredOnly?: boolean } = {}) {
    const rows = await this.conversations
      .createQueryBuilder('c')
      .where('c.is_deleted = false')
      .andWhere('c.organization_id = :orgId', { orgId })
      .andWhere(':me = ANY(c.participant_ids)', { me: userId })
      .getMany();

    // Pinned-first, then most-recent activity. A conversation with no messages
    // yet (a just-created DM) has no lastMessage, so fall back to the row's own
    // updated/created time — otherwise a brand-new chat would sort to the very
    // bottom instead of showing near the top where the user just opened it.
    const activityTime = (c: ConversationEntity): number => {
      const t = c.lastMessage?.sentAt ?? c.updatedAt ?? c.createdAt;
      return t ? new Date(t).getTime() : 0;
    };
    rows.sort((a, b) => {
      const aPinned = a.participants.find((p) => p.userId === userId)?.isPinned ? 1 : 0;
      const bPinned = b.participants.find((p) => p.userId === userId)?.isPinned ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      return activityTime(b) - activityTime(a);
    });

    const names = await this.nameMap(rows.flatMap((c) => c.participants.map((p) => p.userId)));
    let out = rows.map((c) => this.present(c, userId, names));
    if (opts.starredOnly) out = out.filter((c) => (c as any).starred);
    return out;
  }

  async getConversation(conversationId: string, orgId: string, userId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    return this.view(conv, userId);
  }

  // ── participants ────────────────────────────────────────────────────────────

  async addParticipants(conversationId: string, orgId: string, userIds: string[], addedBy: string) {
    const conv = await this.loadForMember(conversationId, orgId, addedBy);
    if (conv.type === 'direct') {
      throw new ForbiddenException('Cannot add participants to a direct conversation');
    }
    const existing = new Set(conv.participants.map((p) => p.userId));
    const toAdd = (userIds ?? []).filter((id) => id && !existing.has(id));
    if (!toAdd.length) return this.view(conv, addedBy);

    conv.participants = [...conv.participants, ...toAdd.map((id) => this.newParticipant(id))];
    this.syncParticipantIds(conv);
    const saved = await this.conversations.save(conv);
    return this.view(saved, addedBy);
  }

  async removeParticipant(conversationId: string, orgId: string, userId: string, removedBy: string) {
    const conv = await this.loadForMember(conversationId, orgId, removedBy);
    if (conv.type === 'direct') {
      throw new ForbiddenException('Cannot remove participants from a direct conversation');
    }
    const remover = conv.participants.find((p) => p.userId === removedBy);
    if (remover!.role !== 'owner' && remover!.role !== 'admin') {
      throw new ForbiddenException('Only owners and admins can remove participants');
    }
    conv.participants = conv.participants.filter((p) => p.userId !== userId);
    this.syncParticipantIds(conv);
    const saved = await this.conversations.save(conv);
    return this.view(saved, removedBy);
  }

  async leave(conversationId: string, orgId: string, userId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    if (conv.type === 'direct') {
      throw new ForbiddenException('Cannot leave a direct conversation');
    }
    conv.participants = conv.participants.filter((p) => p.userId !== userId);
    this.syncParticipantIds(conv);
    await this.conversations.save(conv);
    return { message: 'Left conversation successfully' };
  }

  async convertToGroup(
    conversationId: string,
    orgId: string,
    userId: string,
    newMemberIds: string[],
    groupName?: string,
  ) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    if (conv.type !== 'direct') {
      throw new BadRequestException('Can only convert direct conversations to groups');
    }
    const existing = new Set(conv.participants.map((p) => p.userId));
    conv.type = 'group';
    conv.name = groupName || 'Group';
    for (const id of newMemberIds ?? []) {
      if (!existing.has(id)) conv.participants.push(this.newParticipant(id));
    }
    this.syncParticipantIds(conv);
    const saved = await this.conversations.save(conv);
    return this.view(saved, userId);
  }

  // ── per-user flags ───────────────────────────────────────────────────────

  async togglePin(conversationId: string, orgId: string, userId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    const p = conv.participants.find((x) => x.userId === userId)!;
    p.isPinned = !p.isPinned;
    conv.participants = [...conv.participants];
    await this.conversations.save(conv);
    return { isPinned: p.isPinned };
  }

  async toggleMute(conversationId: string, orgId: string, userId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    const p = conv.participants.find((x) => x.userId === userId)!;
    p.muted = !p.muted;
    conv.participants = [...conv.participants];
    await this.conversations.save(conv);
    return { muted: p.muted };
  }

  async toggleStar(conversationId: string, orgId: string, userId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    const p = conv.participants.find((x) => x.userId === userId)!;
    p.isStarred = !p.isStarred;
    conv.participants = [...conv.participants];
    await this.conversations.save(conv);
    return { isStarred: p.isStarred };
  }

  async unarchive(conversationId: string, orgId: string, userId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    conv.isArchived = false;
    const saved = await this.conversations.save(conv);
    return this.view(saved, userId);
  }

  async archive(conversationId: string, orgId: string, userId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    conv.isArchived = true;
    const saved = await this.conversations.save(conv);
    return this.view(saved, userId);
  }

  async markUnread(conversationId: string, orgId: string, userId: string, fromMessageId: string) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    const p = conv.participants.find((x) => x.userId === userId)!;
    p.lastReadMessageId = fromMessageId;
    p.lastReadAt = new Date(0).toISOString();
    conv.participants = [...conv.participants];
    await this.conversations.save(conv);
  }

  // ── channel admin ─────────────────────────────────────────────────────────

  async updateChannel(
    conversationId: string,
    orgId: string,
    userId: string,
    orgRole: string | null | undefined,
    updates: { name?: string; description?: string; topic?: string; icon?: string },
  ) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    if (conv.type !== 'channel') {
      throw new BadRequestException('Only channels can be edited via this endpoint');
    }
    if (!this.canAdminChannel(conv, userId, orgRole)) {
      throw new ForbiddenException('Only the channel creator or an org admin can edit this channel');
    }
    if (updates.name !== undefined) conv.name = updates.name;
    if (updates.description !== undefined) conv.description = updates.description;
    if (updates.topic !== undefined) conv.topic = updates.topic;
    if (updates.icon !== undefined) conv.icon = updates.icon;
    const saved = await this.conversations.save(conv);
    return this.view(saved, userId);
  }

  async deleteChannel(
    conversationId: string,
    orgId: string,
    userId: string,
    orgRole: string | null | undefined,
  ) {
    const conv = await this.loadForMember(conversationId, orgId, userId);
    if (conv.type !== 'channel') {
      throw new BadRequestException('Only channels can be deleted via this endpoint');
    }
    if (!this.canAdminChannel(conv, userId, orgRole)) {
      throw new ForbiddenException('Only the channel creator or an org admin can delete this channel');
    }
    conv.isDeleted = true;
    await this.conversations.save(conv);
  }

  private canAdminChannel(
    conv: ConversationEntity,
    userId: string,
    orgRole: string | null | undefined,
  ): boolean {
    return conv.createdBy === userId || orgRole === 'admin' || orgRole === 'owner';
  }

  // ── used by MessagesService (same-service internal, already access-checked) ──

  async markAsRead(conversationId: string, userId: string, messageId?: string) {
    const conv = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conv) return;
    const p = conv.participants.find((x) => x.userId === userId);
    if (!p) return;
    p.lastReadAt = new Date().toISOString();
    if (messageId) p.lastReadMessageId = messageId;
    conv.participants = [...conv.participants];
    await this.conversations.save(conv);
  }

  async updateLastMessage(conversationId: string, message: MessageLike) {
    const conv = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conv) return;
    conv.lastMessage = {
      _id: message.id,
      content: message.content ? message.content.substring(0, 100) : null,
      senderId: message.senderId,
      senderName: message.senderName ?? null,
      type: message.type ?? 'text',
      sentAt: new Date().toISOString(),
    };
    conv.messageCount = (conv.messageCount ?? 0) + 1;
    await this.conversations.save(conv);
  }
}

interface MessageLike {
  id: string;
  content?: string;
  senderId: string;
  senderName?: string | null;
  type?: string;
}
