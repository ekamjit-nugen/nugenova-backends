import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { ClientEntity } from './entities/client.entity';
import { ClientContactEntity } from './entities/client-contact.entity';
import { ClientAssignmentEntity } from './entities/client-assignment.entity';
import { BoardClientShareEntity } from './entities/board-client-share.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { DiscussionBoardEntity } from '../discussion-boards/entities/discussion-board.entity';
import { BoardNoteEntity } from '../discussion-boards/entities/board-note.entity';
import { BoardNodeEntity } from '../discussion-boards/entities/board-node.entity';
import { BoardCommentEntity } from '../discussion-boards/entities/board-comment.entity';
import { MailService } from '../../bootstrap/mail/mail.service';
import {
  AssignEmployeeDto, CreateClientDto, CreateContactDto, InviteContactDto, PortalCommentDto, ShareBoardDto, UpdateClientDto, UpdateContactDto,
} from './dto';

export interface ClientsCaller {
  userId: string;
  orgId: string;
  isAdmin: boolean;
}

const nameOf = (u?: UserEntity | null): string =>
  u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Member' : 'Member';

/**
 * Clients module — an org's client companies, their contacts (some promoted to
 * portal logins), the staff assigned to serve them, and the boards shared with
 * them. Everything is org-scoped. A portal user is an OrgMembership with
 * role='client' + personType='client' + clientId (excluded from staff scope).
 */
@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    @InjectRepository(ClientEntity) private readonly clients: Repository<ClientEntity>,
    @InjectRepository(ClientContactEntity) private readonly contacts: Repository<ClientContactEntity>,
    @InjectRepository(ClientAssignmentEntity) private readonly assignments: Repository<ClientAssignmentEntity>,
    @InjectRepository(BoardClientShareEntity) private readonly shares: Repository<BoardClientShareEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(DiscussionBoardEntity) private readonly boards: Repository<DiscussionBoardEntity>,
    @InjectRepository(BoardNoteEntity) private readonly notes: Repository<BoardNoteEntity>,
    @InjectRepository(BoardNodeEntity) private readonly nodes: Repository<BoardNodeEntity>,
    @InjectRepository(BoardCommentEntity) private readonly comments: Repository<BoardCommentEntity>,
    @Optional() private readonly mail?: MailService,
  ) {}

  // ── clients CRUD ────────────────────────────────────────────────────────────

  async create(caller: ClientsCaller, dto: CreateClientDto): Promise<ClientEntity> {
    const dup = await this.clients.findOne({ where: { organizationId: caller.orgId, companyName: ILike(dto.companyName.trim()), isDeleted: false } });
    if (dup) throw new ConflictException('A client with this company name already exists');
    return this.clients.save(this.clients.create({
      organizationId: caller.orgId,
      companyName: dto.companyName.trim(),
      displayName: dto.displayName ?? null,
      industry: dto.industry ?? null,
      website: dto.website ?? null,
      status: 'active',
      tags: dto.tags ?? [],
      notes: dto.notes ?? null,
      primaryContact: dto.primaryContact ?? null,
      createdBy: caller.userId,
      updatedBy: caller.userId,
      isDeleted: false,
    }));
  }

  async list(orgId: string, q: { status?: string; q?: string; tag?: string }) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (q.status === 'active' || q.status === 'archived') where.status = q.status;
    if (q.q) where.companyName = ILike(`%${q.q}%`);
    const rows = await this.clients.find({ where, order: { createdAt: 'DESC' } });
    const filtered = q.tag ? rows.filter((c) => (c.tags ?? []).includes(q.tag as string)) : rows;
    // Attach lightweight counts for the list cards.
    const ids = filtered.map((c) => c.id);
    const [contactCounts, portalCounts, boardCounts] = ids.length
      ? await Promise.all([
          this.contacts.find({ where: { clientId: In(ids), isDeleted: false } }),
          this.memberships.find({ where: { organizationId: orgId, role: 'client', clientId: In(ids) } }),
          this.shares.find({ where: { clientId: In(ids) } }),
        ])
      : [[], [], []];
    const tally = (arr: any[], key: string) => arr.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map<string, number>());
    const c = tally(contactCounts, 'clientId'), p = tally(portalCounts, 'clientId'), b = tally(boardCounts, 'clientId');
    return filtered.map((cl) => ({ ...cl, counts: { contacts: c.get(cl.id) || 0, portalUsers: p.get(cl.id) || 0, sharedBoards: b.get(cl.id) || 0 } }));
  }

  private async require(orgId: string, id: string): Promise<ClientEntity> {
    const c = await this.clients.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!c) throw new NotFoundException('Client not found');
    return c;
  }

  async get(orgId: string, id: string) {
    const client = await this.require(orgId, id);
    const [contacts, assignments, shares] = await Promise.all([
      this.contacts.find({ where: { clientId: id, isDeleted: false }, order: { createdAt: 'ASC' } }),
      this.assignments.find({ where: { clientId: id } }),
      this.shares.find({ where: { clientId: id } }),
    ]);
    const portalMemberships = await this.memberships.find({ where: { organizationId: orgId, role: 'client', clientId: id } });
    const userIds = [...new Set([...assignments.map((a) => a.userId), ...portalMemberships.map((m) => m.userId).filter(Boolean) as string[]])];
    const users = userIds.length ? await this.users.find({ where: { id: In(userIds) } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const boardIds = shares.map((s) => s.boardId);
    const boards = boardIds.length ? await this.boards.find({ where: { id: In(boardIds), organizationId: orgId } }) : [];
    const boardById = new Map(boards.map((b) => [b.id, b]));
    return {
      client,
      contacts,
      assignments: assignments.map((a) => ({ userId: a.userId, name: nameOf(byId.get(a.userId)), email: byId.get(a.userId)?.email ?? null, assignmentRole: a.assignmentRole })),
      portalUsers: portalMemberships.map((m) => ({ userId: m.userId, name: nameOf(m.userId ? byId.get(m.userId) : null), email: m.email, status: m.status })),
      sharedBoards: shares.map((s) => ({ boardId: s.boardId, title: boardById.get(s.boardId)?.title ?? '(deleted board)', permission: s.permission })),
    };
  }

  async update(caller: ClientsCaller, id: string, dto: UpdateClientDto): Promise<ClientEntity> {
    const c = await this.require(caller.orgId, id);
    if (dto.companyName !== undefined) c.companyName = dto.companyName.trim();
    if (dto.displayName !== undefined) c.displayName = dto.displayName;
    if (dto.industry !== undefined) c.industry = dto.industry;
    if (dto.website !== undefined) c.website = dto.website;
    if (dto.tags !== undefined) c.tags = dto.tags;
    if (dto.notes !== undefined) c.notes = dto.notes;
    if (dto.primaryContact !== undefined) c.primaryContact = dto.primaryContact;
    c.updatedBy = caller.userId;
    return this.clients.save(c);
  }

  /** Archive: hides the client + suspends its portal logins (shares kept). */
  async archive(orgId: string, id: string): Promise<ClientEntity> {
    const c = await this.require(orgId, id);
    c.status = 'archived';
    await this.memberships.update({ organizationId: orgId, role: 'client', clientId: id }, { status: 'deactivated' });
    return this.clients.save(c);
  }

  async restore(orgId: string, id: string): Promise<ClientEntity> {
    const c = await this.clients.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!c) throw new NotFoundException('Client not found');
    c.status = 'active';
    await this.memberships.update({ organizationId: orgId, role: 'client', clientId: id }, { status: 'active' });
    return this.clients.save(c);
  }

  /** Soft-delete + cascade: suspend portal logins, drop shares + assignments. */
  async remove(orgId: string, id: string): Promise<{ success: true }> {
    const c = await this.require(orgId, id);
    c.isDeleted = true;
    c.status = 'archived';
    await this.clients.save(c);
    await this.memberships.update({ organizationId: orgId, role: 'client', clientId: id }, { status: 'deactivated' });
    await this.shares.delete({ clientId: id });
    await this.assignments.delete({ clientId: id });
    await this.contacts.update({ clientId: id }, { isDeleted: true });
    return { success: true };
  }

  // ── contacts + portal invite ────────────────────────────────────────────────

  async addContact(orgId: string, clientId: string, dto: CreateContactDto): Promise<ClientContactEntity> {
    await this.require(orgId, clientId);
    return this.contacts.save(this.contacts.create({
      organizationId: orgId, clientId,
      name: dto.name.trim(), email: dto.email?.toLowerCase() ?? null, phone: dto.phone ?? null, designation: dto.designation ?? null,
      userId: null, isDeleted: false,
    }));
  }

  async updateContact(orgId: string, clientId: string, contactId: string, dto: UpdateContactDto): Promise<ClientContactEntity> {
    const c = await this.contacts.findOne({ where: { id: contactId, clientId, organizationId: orgId, isDeleted: false } });
    if (!c) throw new NotFoundException('Contact not found');
    if (dto.name !== undefined) c.name = dto.name.trim();
    if (dto.email !== undefined) c.email = dto.email?.toLowerCase() ?? null;
    if (dto.phone !== undefined) c.phone = dto.phone;
    if (dto.designation !== undefined) c.designation = dto.designation;
    return this.contacts.save(c);
  }

  async removeContact(orgId: string, clientId: string, contactId: string): Promise<{ success: true }> {
    const c = await this.contacts.findOne({ where: { id: contactId, clientId, organizationId: orgId } });
    if (!c) throw new NotFoundException('Contact not found');
    // If this contact had a portal login, deactivate it too.
    if (c.userId) await this.memberships.update({ organizationId: orgId, userId: c.userId, clientId }, { status: 'deactivated' });
    c.isDeleted = true;
    await this.contacts.save(c);
    return { success: true };
  }

  /** Promote a contact to a portal login (creates the client-role membership). */
  async inviteContact(caller: ClientsCaller, clientId: string, contactId: string, dto: InviteContactDto) {
    const orgId = caller.orgId;
    const client = await this.require(orgId, clientId);
    const contact = await this.contacts.findOne({ where: { id: contactId, clientId, organizationId: orgId, isDeleted: false } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (!contact.email) throw new BadRequestException('Add an email to this contact before inviting them to the portal');
    const email = contact.email.toLowerCase();

    let user = await this.users.findOne({ where: { email } });
    if (!user) {
      user = await this.users.save(this.users.create({
        email, password: 'pending-otp-' + randomUUID(),
        firstName: dto.firstName || contact.name.split(' ')[0] || 'Client', lastName: dto.lastName || contact.name.split(' ').slice(1).join(' ') || '',
        isActive: true, setupStage: 'complete',
      }));
    }

    // Guard: this person must not already be a member of THIS org in another role.
    const existing = await this.memberships.findOne({ where: { organizationId: orgId, userId: user.id } });
    if (existing) {
      if (existing.role !== 'client') throw new ConflictException('This email is already a staff member of this organization');
      if (existing.clientId && existing.clientId !== clientId) throw new ConflictException('This email is already a portal user of another client');
      existing.status = 'active';
      existing.clientId = clientId;
      await this.memberships.save(existing);
    } else {
      await this.memberships.save(this.memberships.create({
        userId: user.id, email, organizationId: orgId,
        role: 'client', personType: 'client', clientId, status: 'active',
        invitedBy: caller.userId, joinedAt: new Date(),
      }));
    }

    const orgs = new Set(user.organizations || []); orgs.add(orgId); user.organizations = [...orgs];
    if (!user.defaultOrganizationId) user.defaultOrganizationId = orgId;
    await this.users.save(user);

    contact.userId = user.id;
    await this.contacts.save(contact);

    void this.mail?.send({
      to: email,
      subject: `You've been invited to ${client.companyName}'s client portal`,
      html: `<p>Hello ${contact.name},</p><p>You've been given access to the client portal where you can follow the work and discussions shared with you. Sign in with this email to get started.</p>`,
      category: 'clients.portal_invite',
      organizationId: orgId,
    }).catch(() => undefined);

    return { userId: user.id, email, status: 'active' };
  }

  async deactivatePortalUser(orgId: string, clientId: string, userId: string): Promise<{ success: true }> {
    const m = await this.memberships.findOne({ where: { organizationId: orgId, userId, clientId, role: 'client' } });
    if (!m) throw new NotFoundException('Portal user not found');
    m.status = 'deactivated';
    await this.memberships.save(m);
    return { success: true };
  }

  // ── employee assignments ────────────────────────────────────────────────────

  async assignEmployee(caller: ClientsCaller, clientId: string, dto: AssignEmployeeDto): Promise<ClientAssignmentEntity> {
    const orgId = caller.orgId;
    await this.require(orgId, clientId);
    const staff = await this.memberships.findOne({ where: { organizationId: orgId, userId: dto.userId } });
    if (!staff || staff.role === 'client') throw new BadRequestException('Only an active staff member can be assigned to a client');
    const existing = await this.assignments.findOne({ where: { clientId, userId: dto.userId } });
    if (existing) {
      existing.assignmentRole = dto.assignmentRole ?? existing.assignmentRole;
      return this.assignments.save(existing);
    }
    return this.assignments.save(this.assignments.create({
      organizationId: orgId, clientId, userId: dto.userId, assignmentRole: dto.assignmentRole ?? null, createdBy: caller.userId,
    }));
  }

  async unassignEmployee(orgId: string, clientId: string, userId: string): Promise<{ success: true }> {
    await this.assignments.delete({ organizationId: orgId, clientId, userId });
    return { success: true };
  }

  /** Clients a staff member is assigned to ("My clients"). */
  async myClients(orgId: string, userId: string) {
    const links = await this.assignments.find({ where: { organizationId: orgId, userId } });
    if (!links.length) return [];
    const clients = await this.clients.find({ where: { id: In(links.map((l) => l.clientId)), organizationId: orgId, isDeleted: false } });
    const roleByClient = new Map(links.map((l) => [l.clientId, l.assignmentRole]));
    return clients.map((c) => ({ ...c, assignmentRole: roleByClient.get(c.id) ?? null }));
  }

  // ── board sharing ───────────────────────────────────────────────────────────

  private canAccessBoard(board: DiscussionBoardEntity, caller: ClientsCaller): boolean {
    if (caller.isAdmin) return true;
    if (board.createdBy === caller.userId) return true;
    return Array.isArray(board.participants) && (board.participants as any[]).some((p) => p?.userId === caller.userId);
  }

  async shareBoard(caller: ClientsCaller, clientId: string, dto: ShareBoardDto): Promise<BoardClientShareEntity> {
    const orgId = caller.orgId;
    await this.require(orgId, clientId);
    const board = await this.boards.findOne({ where: { id: dto.boardId, organizationId: orgId } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccessBoard(board, caller)) throw new ForbiddenException('You can only share boards you have access to');
    const existing = await this.shares.findOne({ where: { boardId: dto.boardId, clientId } });
    if (existing) {
      existing.permission = dto.permission ?? existing.permission;
      return this.shares.save(existing);
    }
    return this.shares.save(this.shares.create({
      organizationId: orgId, boardId: dto.boardId, clientId, permission: dto.permission ?? 'view', sharedBy: caller.userId,
    }));
  }

  async unshareBoard(orgId: string, clientId: string, boardId: string): Promise<{ success: true }> {
    await this.shares.delete({ organizationId: orgId, clientId, boardId });
    return { success: true };
  }

  // ── portal (client-role caller) ─────────────────────────────────────────────

  /** The clientId a portal user belongs to (from their client-role membership). */
  async clientIdForUser(orgId: string, userId: string): Promise<string | null> {
    const m = await this.memberships.findOne({ where: { organizationId: orgId, userId, role: 'client', status: 'active' } });
    return m?.clientId ?? null;
  }

  /** Portal home: the client's profile, delivery team, and shared boards. */
  async portalOverview(orgId: string, userId: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const client = await this.clients.findOne({ where: { id: clientId, organizationId: orgId, isDeleted: false } });
    if (!client || client.status !== 'active') throw new ForbiddenException('This client portal is not active');
    const [assignments, shares] = await Promise.all([
      this.assignments.find({ where: { clientId } }),
      this.shares.find({ where: { clientId } }),
    ]);
    const staffUsers = assignments.length ? await this.users.find({ where: { id: In(assignments.map((a) => a.userId)) } }) : [];
    const byId = new Map(staffUsers.map((u) => [u.id, u]));
    const boards = shares.length ? await this.boards.find({ where: { id: In(shares.map((s) => s.boardId)), organizationId: orgId } }) : [];
    const boardById = new Map(boards.map((b) => [b.id, b]));
    return {
      client: { id: client.id, companyName: client.companyName, displayName: client.displayName, industry: client.industry, website: client.website },
      team: assignments.map((a) => ({ name: nameOf(byId.get(a.userId)), designation: a.assignmentRole })),
      boards: shares
        .filter((s) => boardById.has(s.boardId))
        .map((s) => ({ boardId: s.boardId, title: boardById.get(s.boardId)!.title, description: boardById.get(s.boardId)!.description, permission: s.permission })),
    };
  }

  /** The share row for (portal user → board), or null if not shared with them. */
  private async portalShare(orgId: string, userId: string, boardId: string): Promise<BoardClientShareEntity | null> {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) return null;
    return this.shares.findOne({ where: { organizationId: orgId, clientId, boardId } });
  }

  /** Read a board the portal user's client has been shared (notes + comments). */
  async portalBoard(orgId: string, userId: string, boardId: string) {
    const share = await this.portalShare(orgId, userId, boardId);
    if (!share) throw new ForbiddenException('This board is not shared with you');
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    const [notes, nodes, comments] = await Promise.all([
      this.notes.find({ where: { boardId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } }),
      this.nodes.find({ where: { boardId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } }),
      this.comments.find({ where: { boardId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } }),
    ]);
    return { board: { id: board.id, title: board.title, description: board.description }, notes, nodes, comments, permission: share.permission };
  }

  /** Portal user posts a comment (requires 'comment' permission on the board). */
  async portalComment(orgId: string, userId: string, boardId: string, dto: PortalCommentDto): Promise<BoardCommentEntity> {
    const share = await this.portalShare(orgId, userId, boardId);
    if (!share) throw new ForbiddenException('This board is not shared with you');
    if (share.permission !== 'comment') throw new ForbiddenException('You have view-only access to this board');
    const text = (dto.text || '').trim();
    if (!text) throw new BadRequestException('Comment cannot be empty');
    const user = await this.users.findOne({ where: { id: userId } });
    return this.comments.save(this.comments.create({
      organizationId: orgId, boardId, noteId: dto.noteId ?? null,
      authorId: userId, authorName: nameOf(user), text, isDeleted: false,
    }));
  }
}
