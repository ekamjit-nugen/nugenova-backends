import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { ClientEntity } from './entities/client.entity';
import { ClientContactEntity } from './entities/client-contact.entity';
import { ClientAssignmentEntity } from './entities/client-assignment.entity';
import { BoardClientShareEntity } from './entities/board-client-share.entity';
import { ClientAgreementEntity } from './entities/client-agreement.entity';
import { ClientAgreementTemplateEntity } from './entities/client-agreement-template.entity';
import { ClientDocumentEntity, DocumentSignature } from './entities/client-document.entity';
import { ClientTicketEntity } from './entities/client-ticket.entity';
import { ClientTicketMessageEntity } from './entities/client-ticket-message.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { DiscussionBoardEntity } from '../discussion-boards/entities/discussion-board.entity';
import { BoardNoteEntity } from '../discussion-boards/entities/board-note.entity';
import { BoardNodeEntity } from '../discussion-boards/entities/board-node.entity';
import { BoardCommentEntity } from '../discussion-boards/entities/board-comment.entity';
import { MailService } from '../../bootstrap/mail/mail.service';
import { NotifierService } from '../notification/notifier.service';
import { EMAIL_OVERRIDES } from '../notification/notification-catalog';
import { clientPortalInviteEmail } from '../../bootstrap/mail/email-layout';
import {
  AssignEmployeeDto, CreateAgreementDto, CreateAgreementTemplateDto, CreateClientDto, CreateContactDto, CreateDocumentDto, CreateTicketDto, InviteContactDto, PortalCommentDto, PortalUploadDocumentDto, ShareBoardDto, SignAgreementDto, SignDocumentDto, TicketMessageDto, UpdateAgreementDto, UpdateAgreementTemplateDto, UpdateClientDto, UpdateContactDto, UpdateDocumentDto, UpdateTicketDto,
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
    @InjectRepository(ClientAgreementEntity) private readonly agreements: Repository<ClientAgreementEntity>,
    @InjectRepository(ClientAgreementTemplateEntity) private readonly agreementTemplates: Repository<ClientAgreementTemplateEntity>,
    @InjectRepository(ClientDocumentEntity) private readonly documents: Repository<ClientDocumentEntity>,
    @InjectRepository(ClientTicketEntity) private readonly tickets: Repository<ClientTicketEntity>,
    @InjectRepository(ClientTicketMessageEntity) private readonly ticketMessages: Repository<ClientTicketMessageEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(DiscussionBoardEntity) private readonly boards: Repository<DiscussionBoardEntity>,
    @InjectRepository(BoardNoteEntity) private readonly notes: Repository<BoardNoteEntity>,
    @InjectRepository(BoardNodeEntity) private readonly nodes: Repository<BoardNodeEntity>,
    @InjectRepository(BoardCommentEntity) private readonly comments: Repository<BoardCommentEntity>,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly notifier?: NotifierService,
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

  /** Admin dashboard summary: client counts + agreement activity for the org. */
  async dashboardSummary(orgId: string) {
    const [activeClientRows, allAgreements] = await Promise.all([
      this.clients.find({ where: { organizationId: orgId, status: 'active', isDeleted: false }, select: { id: true, companyName: true, displayName: true } }),
      this.agreements.find({ where: { organizationId: orgId, isDeleted: false }, order: { signedAt: 'DESC', createdAt: 'DESC' } }),
    ]);
    const pending = allAgreements.filter((a) => a.status === 'sent');
    const signed = allAgreements.filter((a) => a.status === 'signed');
    // Active clients that have not yet had ANY agreement signed → the nudge set.
    const signedClientIds = new Set(signed.map((a) => a.clientId));
    const needing = activeClientRows.filter((c) => !signedClientIds.has(c.id));

    const nameById = new Map(activeClientRows.map((c) => [c.id, c.displayName || c.companyName]));
    const shape = (a: ClientAgreementEntity) => ({
      id: a.id, clientId: a.clientId, clientName: nameById.get(a.clientId) ?? 'Client',
      title: a.title, status: a.status, signerName: a.signature?.signerName ?? null,
      signedAt: a.signedAt, sentAt: a.sentAt,
    });
    return {
      activeClients: activeClientRows.length,
      agreementsPending: pending.length,
      agreementsSigned: signed.length,
      clientsNeedingAgreement: needing.length,
      needingAgreement: needing.slice(0, 6).map((c) => ({ id: c.id, name: c.displayName || c.companyName })),
      pending: pending.slice(0, 5).map(shape),
      recentlySigned: signed.slice(0, 5).map(shape),
    };
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
    await this.agreements.update({ clientId: id }, { isDeleted: true });
    await this.documents.update({ clientId: id }, { isDeleted: true });
    await this.tickets.update({ clientId: id }, { isDeleted: true });
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

    const invite = clientPortalInviteEmail({ contactName: contact.name, companyName: client.companyName });
    void this.mail?.send({
      to: email,
      subject: invite.subject,
      html: invite.html,
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

  // ── agreements (admin) ───────────────────────────────────────────────────────

  private async requireAgreement(orgId: string, clientId: string, id: string): Promise<ClientAgreementEntity> {
    const a = await this.agreements.findOne({ where: { id, clientId, organizationId: orgId, isDeleted: false } });
    if (!a) throw new NotFoundException('Agreement not found');
    return a;
  }

  async listAgreements(orgId: string, clientId: string) {
    await this.require(orgId, clientId);
    return this.agreements.find({ where: { clientId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'DESC' } });
  }

  async createAgreement(caller: ClientsCaller, clientId: string, dto: CreateAgreementDto): Promise<ClientAgreementEntity> {
    await this.require(caller.orgId, clientId);
    if (!dto.bodyHtml?.trim() && !dto.sourceFileId) {
      throw new BadRequestException('Provide agreement text or attach a PDF');
    }
    return this.agreements.save(this.agreements.create({
      organizationId: caller.orgId, clientId,
      title: dto.title.trim(),
      description: dto.description ?? null,
      category: dto.category ?? 'other',
      bodyHtml: dto.bodyHtml ?? null,
      sourceFileId: dto.sourceFileId ?? null,
      fields: (dto.fields ?? null) as any,
      signedFileId: null,
      status: 'draft',
      signature: null, sentAt: null, signedAt: null,
      createdBy: caller.userId, isDeleted: false,
    }));
  }

  async updateAgreement(orgId: string, clientId: string, id: string, dto: UpdateAgreementDto): Promise<ClientAgreementEntity> {
    const a = await this.requireAgreement(orgId, clientId, id);
    if (a.status === 'signed') throw new BadRequestException('A signed agreement cannot be edited');
    if (dto.title !== undefined) a.title = dto.title.trim();
    if (dto.description !== undefined) a.description = dto.description;
    if (dto.category !== undefined) a.category = dto.category;
    if (dto.bodyHtml !== undefined) a.bodyHtml = dto.bodyHtml;
    if (dto.sourceFileId !== undefined) a.sourceFileId = dto.sourceFileId;
    if (dto.fields !== undefined) a.fields = dto.fields as any;
    return this.agreements.save(a);
  }

  /** Send the agreement to the client portal (draft → sent). */
  async sendAgreement(orgId: string, clientId: string, id: string): Promise<ClientAgreementEntity> {
    const a = await this.requireAgreement(orgId, clientId, id);
    if (a.status === 'signed') throw new BadRequestException('This agreement is already signed');
    a.status = 'sent';
    a.sentAt = a.sentAt ?? new Date();
    return this.agreements.save(a);
  }

  /** Withdraw a sent (unsigned) agreement (sent/draft → void). */
  async voidAgreement(orgId: string, clientId: string, id: string): Promise<ClientAgreementEntity> {
    const a = await this.requireAgreement(orgId, clientId, id);
    if (a.status === 'signed') throw new BadRequestException('A signed agreement cannot be voided');
    a.status = 'void';
    return this.agreements.save(a);
  }

  async deleteAgreement(orgId: string, clientId: string, id: string): Promise<{ success: true }> {
    const a = await this.requireAgreement(orgId, clientId, id);
    a.isDeleted = true;
    await this.agreements.save(a);
    return { success: true };
  }

  // ── agreement templates (admin) ──────────────────────────────────────────────

  async listTemplates(orgId: string) {
    return this.agreementTemplates.find({ where: { organizationId: orgId, isDeleted: false }, order: { createdAt: 'DESC' } });
  }

  async createTemplate(caller: ClientsCaller, dto: CreateAgreementTemplateDto): Promise<ClientAgreementTemplateEntity> {
    if (!dto.bodyHtml?.trim() && !dto.sourceFileId) {
      throw new BadRequestException('Provide agreement text or attach a PDF');
    }
    return this.agreementTemplates.save(this.agreementTemplates.create({
      organizationId: caller.orgId,
      name: dto.name.trim(),
      title: dto.title?.trim() || null,
      category: dto.category ?? 'other',
      bodyHtml: dto.bodyHtml ?? null,
      sourceFileId: dto.sourceFileId ?? null,
      fields: (dto.fields ?? null) as any,
      createdBy: caller.userId, isDeleted: false,
    }));
  }

  async updateTemplate(orgId: string, id: string, dto: UpdateAgreementTemplateDto): Promise<ClientAgreementTemplateEntity> {
    const t = await this.agreementTemplates.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Template not found');
    if (dto.name !== undefined) t.name = dto.name.trim();
    if (dto.title !== undefined) t.title = dto.title;
    if (dto.category !== undefined) t.category = dto.category;
    if (dto.bodyHtml !== undefined) t.bodyHtml = dto.bodyHtml;
    if (dto.sourceFileId !== undefined) t.sourceFileId = dto.sourceFileId;
    if (dto.fields !== undefined) t.fields = dto.fields as any;
    return this.agreementTemplates.save(t);
  }

  async deleteTemplate(orgId: string, id: string): Promise<{ success: true }> {
    const t = await this.agreementTemplates.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Template not found');
    t.isDeleted = true;
    await this.agreementTemplates.save(t);
    return { success: true };
  }

  // ── agreement reminders ──────────────────────────────────────────────────────

  private static readonly REMIND_AFTER_DAYS = 3;
  private static readonly REMIND_INTERVAL_DAYS = 3;
  private static readonly MAX_REMINDERS = 3;

  /** Email + in-app nudge to the client's active portal users to sign an agreement. */
  private async notifyClientToSign(a: ClientAgreementEntity, companyName: string): Promise<number> {
    if (!this.notifier) return 0;
    const members = await this.memberships.find({ where: { organizationId: a.organizationId, clientId: a.clientId, role: 'client', status: 'active' } });
    let sent = 0;
    for (const m of members) {
      if (!m.userId) continue;
      await this.notifier.notify({
        organizationId: a.organizationId,
        userId: m.userId,
        type: 'client_agreement_reminder',
        title: `Reminder: please sign “${a.title}”`,
        body: `${companyName} is waiting for your signature on “${a.title}”.`,
        data: { actionUrl: `/portal/agreements/${a.id}`, agreementId: a.id },
        email: EMAIL_OVERRIDES.agreementSignRequest(a.title),
      }).catch(() => undefined);
      sent++;
    }
    return sent;
  }

  /** Admin manually nudges the client to sign a sent (unsigned) agreement. */
  async remindAgreement(orgId: string, clientId: string, id: string) {
    const a = await this.requireAgreement(orgId, clientId, id);
    if (a.status !== 'sent') throw new BadRequestException('Only a sent, unsigned agreement can be reminded');
    const client = await this.clients.findOne({ where: { id: clientId } });
    await this.notifyClientToSign(a, client?.companyName ?? 'The organization');
    a.lastReminderAt = new Date();
    a.reminderCount = (a.reminderCount ?? 0) + 1;
    await this.agreements.save(a);
    return this.agreementView(a);
  }

  /** Cron sweep: auto-remind clients about sent agreements they haven't signed. */
  async runAgreementReminders(now: Date = new Date()): Promise<{ checked: number; notified: number }> {
    const sent = await this.agreements.find({ where: { status: 'sent', isDeleted: false } });
    let notified = 0;
    const clientNameCache = new Map<string, string>();
    for (const a of sent) {
      const count = a.reminderCount ?? 0;
      if (count >= ClientsService.MAX_REMINDERS) continue;
      const baseline = a.lastReminderAt ?? a.sentAt;
      if (!baseline) continue;
      const days = (now.getTime() - new Date(baseline).getTime()) / 86_400_000;
      const threshold = count === 0 ? ClientsService.REMIND_AFTER_DAYS : ClientsService.REMIND_INTERVAL_DAYS;
      if (days < threshold) continue;
      let name = clientNameCache.get(a.clientId);
      if (name === undefined) {
        const client = await this.clients.findOne({ where: { id: a.clientId } });
        name = client?.companyName ?? 'The organization';
        clientNameCache.set(a.clientId, name);
      }
      const n = await this.notifyClientToSign(a, name);
      if (n > 0) {
        a.lastReminderAt = now;
        a.reminderCount = count + 1;
        await this.agreements.save(a);
        notified++;
      }
    }
    return { checked: sent.length, notified };
  }

  // ── document vault (admin) ───────────────────────────────────────────────────

  async listDocuments(orgId: string, clientId: string) {
    await this.require(orgId, clientId);
    const rows = await this.documents.find({ where: { clientId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'DESC' } });
    return rows.map((d) => this.documentView(d));
  }

  /**
   * Put a document in the client's vault. Normally that means WE are sharing it
   * (and may tick `signatureRequired` to ask them to sign); `fromClient` records
   * one they sent that arrived by email, so a document that came the other way
   * still lands in the same place with an honest note of how it got here.
   */
  async addDocument(caller: ClientsCaller, clientId: string, dto: CreateDocumentDto) {
    await this.require(caller.orgId, clientId);
    const fromClient = !!dto.fromClient;
    const saved = await this.documents.save(this.documents.create({
      organizationId: caller.orgId, clientId,
      fileId: dto.fileId, fileName: dto.fileName,
      mimeType: dto.mimeType ?? null, size: dto.size ?? null,
      title: dto.title?.trim() || null, description: dto.description?.trim() || null,
      origin: fromClient ? 'client' : 'org',
      channel: fromClient ? 'email' : null,
      uploadedByName: fromClient ? (dto.fromName?.trim() || null) : null,
      // Only a document we share can carry a "please sign" for the client.
      signatureRequired: !fromClient && !!dto.signatureRequired,
      signatureRequestedFromUs: fromClient && !!dto.requestOurSignature,
      signature: null, signedAt: null, signedFileId: null,
      createdBy: caller.userId, isDeleted: false,
    }));
    return this.documentView(saved);
  }

  /** Turn the "client must sign" tick on or off after the fact. */
  async updateDocument(orgId: string, clientId: string, docId: string, dto: UpdateDocumentDto) {
    const d = await this.requireDocument(orgId, clientId, docId);
    if (dto.signatureRequired !== undefined) {
      if (d.signature) throw new BadRequestException('This document has already been signed');
      if (d.origin === 'client') throw new BadRequestException('This document came from the client — they cannot be asked to sign it');
      d.signatureRequired = dto.signatureRequired;
    }
    if (dto.title !== undefined) d.title = dto.title?.trim() || null;
    if (dto.description !== undefined) d.description = dto.description?.trim() || null;
    return this.documentView(await this.documents.save(d));
  }

  /** Everything across the org waiting on OUR signature — the staff queue. */
  async documentsAwaitingUs(orgId: string) {
    const rows = await this.documents.find({
      where: { organizationId: orgId, isDeleted: false, signatureRequestedFromUs: true },
      order: { createdAt: 'DESC' },
    });
    const pending = rows.filter((d) => !d.signature);
    const clients = pending.length
      ? await this.clients.find({ where: { id: In([...new Set(pending.map((d) => d.clientId))]) } })
      : [];
    const byId = new Map(clients.map((c) => [c.id, c]));
    return pending.map((d) => ({ ...this.documentView(d), clientName: byId.get(d.clientId)?.companyName ?? null }));
  }

  /** We sign a document the client sent us. */
  async signDocumentAsOrg(caller: ClientsCaller, clientId: string, docId: string, dto: SignDocumentDto, ip?: string, ua?: string) {
    const d = await this.requireDocument(caller.orgId, clientId, docId);
    if (d.origin !== 'client') throw new BadRequestException('This is a document you shared — the client signs it, not you');
    if (d.signature) throw new BadRequestException('This document has already been signed');
    return this.documentView(await this.documents.save(this.applySignature(d, caller.userId, dto, ip, ua, dto.signedFileId)));
  }

  /** The client signs a document we asked them to sign (portal). */
  async signDocumentAsClient(orgId: string, userId: string, docId: string, dto: SignDocumentDto, ip?: string, ua?: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const d = await this.documents.findOne({ where: { id: docId, clientId, organizationId: orgId, isDeleted: false } });
    if (!d) throw new NotFoundException('Document not found');
    if (!d.signatureRequired) throw new BadRequestException('This document does not need your signature');
    if (d.signature) throw new BadRequestException('This document has already been signed');
    return this.documentView(await this.documents.save(this.applySignature(d, userId, dto, ip, ua, dto.signedFileId)));
  }

  /** A client sends us a document from their portal, optionally to sign. */
  async portalUploadDocument(orgId: string, userId: string, dto: PortalUploadDocumentDto) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const user = await this.users.findOne({ where: { id: userId } });
    const saved = await this.documents.save(this.documents.create({
      organizationId: orgId, clientId,
      fileId: dto.fileId, fileName: dto.fileName,
      mimeType: dto.mimeType ?? null, size: dto.size ?? null,
      title: dto.title?.trim() || null, description: dto.description?.trim() || null,
      origin: 'client', channel: 'portal', uploadedByName: nameOf(user),
      signatureRequired: false,
      signatureRequestedFromUs: !!dto.requestOurSignature,
      signature: null, signedAt: null, signedFileId: null,
      createdBy: userId, isDeleted: false,
    }));
    return this.documentView(saved);
  }

  private applySignature(d: ClientDocumentEntity, userId: string, dto: SignDocumentDto, ip?: string, ua?: string, signedFileId?: string) {
    if (!dto.signerName?.trim()) throw new BadRequestException('A signer name is required to sign');
    const now = new Date();
    const signature: DocumentSignature = {
      signerName: dto.signerName.trim(),
      signerEmail: dto.signerEmail?.toLowerCase() ?? null,
      signedByUserId: userId,
      signedAt: now.toISOString(),
      ipAddress: ip ?? null,
      userAgent: ua ?? null,
      method: dto.method || 'typed',
    };
    d.signature = signature;
    d.signedAt = now;
    if (signedFileId) d.signedFileId = signedFileId;
    return d;
  }

  private async requireDocument(orgId: string, clientId: string, docId: string): Promise<ClientDocumentEntity> {
    const d = await this.documents.findOne({ where: { id: docId, clientId, organizationId: orgId, isDeleted: false } });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  async removeDocument(orgId: string, clientId: string, docId: string): Promise<{ success: true }> {
    const d = await this.documents.findOne({ where: { id: docId, clientId, organizationId: orgId, isDeleted: false } });
    if (!d) throw new NotFoundException('Document not found');
    d.isDeleted = true;
    await this.documents.save(d);
    return { success: true };
  }

  /** Documents shared with the caller's client (portal). */
  async portalDocuments(orgId: string, userId: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const rows = await this.documents.find({ where: { clientId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'DESC' } });
    return rows.map((d) => this.documentView(d));
  }

  private documentView(d: ClientDocumentEntity) {
    return {
      id: d.id, clientId: d.clientId, fileId: d.fileId,
      name: d.title || d.fileName, fileName: d.fileName,
      mimeType: d.mimeType, size: d.size != null ? Number(d.size) : null,
      description: d.description, createdAt: d.createdAt,
      origin: d.origin ?? 'org', channel: d.channel, uploadedByName: d.uploadedByName,
      signatureRequired: !!d.signatureRequired,
      signatureRequestedFromUs: !!d.signatureRequestedFromUs,
      signature: d.signature, signedAt: d.signedAt, signedFileId: d.signedFileId,
      // Derived so it can never go stale: what, if anything, this document is waiting for.
      status: d.signature
        ? 'signed'
        : d.signatureRequired
          ? 'awaiting_client'
          : d.signatureRequestedFromUs
            ? 'awaiting_us'
            : 'shared',
    };
  }

  // ── support tickets ──────────────────────────────────────────────────────────

  private ticketView(t: ClientTicketEntity) {
    return {
      id: t.id, clientId: t.clientId, subject: t.subject, description: t.description,
      category: t.category, status: t.status, priority: t.priority,
      createdByName: t.createdByName, createdByRole: t.createdByRole,
      assignedToUserId: t.assignedToUserId, lastMessageAt: t.lastMessageAt, createdAt: t.createdAt,
    };
  }
  private ticketMessageView(m: ClientTicketMessageEntity) {
    return { id: m.id, authorName: m.authorName, authorRole: m.authorRole, body: m.body, createdAt: m.createdAt };
  }

  /** Staff to notify about a client's ticket: its delivery team + assignee, minus the actor. */
  private async ticketStaffRecipients(clientId: string, assignedTo: string | null, exclude?: string): Promise<string[]> {
    const links = await this.assignments.find({ where: { clientId } });
    const ids = new Set<string>(links.map((l) => l.userId));
    if (assignedTo) ids.add(assignedTo);
    if (exclude) ids.delete(exclude);
    return [...ids];
  }
  private async ticketClientRecipients(orgId: string, clientId: string, exclude?: string): Promise<string[]> {
    const members = await this.memberships.find({ where: { organizationId: orgId, clientId, role: 'client', status: 'active' } });
    const ids = new Set<string>(members.map((m) => m.userId).filter(Boolean) as string[]);
    if (exclude) ids.delete(exclude);
    return [...ids];
  }
  private async notifyTicket(orgId: string, userIds: string[], type: string, title: string, body: string, ticketId: string, actionUrl: string) {
    if (!this.notifier) return;
    for (const userId of userIds) {
      await this.notifier.notify({
        organizationId: orgId, userId, type, title, body: body || null,
        data: { actionUrl, ticketId }, email: EMAIL_OVERRIDES.supportRequest,
      }).catch(() => undefined);
    }
  }

  // admin
  async listTicketsForClient(orgId: string, clientId: string) {
    await this.require(orgId, clientId);
    const rows = await this.tickets.find({ where: { clientId, organizationId: orgId, isDeleted: false }, order: { lastMessageAt: 'DESC', createdAt: 'DESC' } });
    return rows.map((t) => this.ticketView(t));
  }

  async listTickets(orgId: string, q: { status?: string }) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (q.status) where.status = q.status;
    const rows = await this.tickets.find({ where, order: { lastMessageAt: 'DESC', createdAt: 'DESC' } });
    const clientIds = [...new Set(rows.map((t) => t.clientId))];
    const clients = clientIds.length ? await this.clients.find({ where: { id: In(clientIds), organizationId: orgId } }) : [];
    const nameById = new Map(clients.map((c) => [c.id, c.displayName || c.companyName]));
    return rows.map((t) => ({ ...this.ticketView(t), clientName: nameById.get(t.clientId) ?? 'Client' }));
  }

  async getTicketAdmin(orgId: string, ticketId: string) {
    const t = await this.tickets.findOne({ where: { id: ticketId, organizationId: orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Ticket not found');
    const msgs = await this.ticketMessages.find({ where: { ticketId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } });
    return { ticket: this.ticketView(t), messages: msgs.map((m) => this.ticketMessageView(m)) };
  }

  async createTicketAsStaff(caller: ClientsCaller, clientId: string, dto: CreateTicketDto) {
    await this.require(caller.orgId, clientId);
    const user = await this.users.findOne({ where: { id: caller.userId } });
    const t = await this.tickets.save(this.tickets.create({
      organizationId: caller.orgId, clientId, subject: dto.subject.trim(), description: dto.description ?? null,
      category: dto.category ?? 'request', status: 'open', priority: (dto.priority ?? 'normal') as any,
      createdBy: caller.userId, createdByName: nameOf(user), createdByRole: 'staff',
      assignedToUserId: caller.userId, lastMessageAt: new Date(), isDeleted: false,
    }));
    const recips = await this.ticketClientRecipients(caller.orgId, clientId);
    await this.notifyTicket(caller.orgId, recips, 'client_ticket_created', `New request: ${t.subject}`, t.description ?? '', t.id, `/portal/tickets/${t.id}`);
    return this.ticketView(t);
  }

  async updateTicket(orgId: string, ticketId: string, dto: UpdateTicketDto) {
    const t = await this.tickets.findOne({ where: { id: ticketId, organizationId: orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Ticket not found');
    if (dto.status !== undefined) t.status = dto.status as any;
    if (dto.priority !== undefined) t.priority = dto.priority as any;
    if (dto.assignedToUserId !== undefined) t.assignedToUserId = dto.assignedToUserId || null;
    await this.tickets.save(t);
    return this.ticketView(t);
  }

  async staffReply(caller: ClientsCaller, ticketId: string, dto: TicketMessageDto) {
    const t = await this.tickets.findOne({ where: { id: ticketId, organizationId: caller.orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Ticket not found');
    const body = (dto.body || '').trim();
    if (!body) throw new BadRequestException('Message cannot be empty');
    const user = await this.users.findOne({ where: { id: caller.userId } });
    const m = await this.ticketMessages.save(this.ticketMessages.create({
      organizationId: caller.orgId, ticketId, authorId: caller.userId, authorName: nameOf(user), authorRole: 'staff', body, isDeleted: false,
    }));
    t.lastMessageAt = new Date();
    if (t.status === 'open') t.status = 'in_progress';
    await this.tickets.save(t);
    const recips = await this.ticketClientRecipients(caller.orgId, t.clientId);
    await this.notifyTicket(caller.orgId, recips, 'client_ticket_reply', `New reply: ${t.subject}`, body, t.id, `/portal/tickets/${t.id}`);
    return this.ticketMessageView(m);
  }

  // portal
  async portalListTickets(orgId: string, userId: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const rows = await this.tickets.find({ where: { clientId, organizationId: orgId, isDeleted: false }, order: { lastMessageAt: 'DESC', createdAt: 'DESC' } });
    return rows.map((t) => this.ticketView(t));
  }

  async portalCreateTicket(orgId: string, userId: string, dto: CreateTicketDto) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const subject = dto.subject?.trim();
    if (!subject) throw new BadRequestException('A subject is required');
    const user = await this.users.findOne({ where: { id: userId } });
    const t = await this.tickets.save(this.tickets.create({
      organizationId: orgId, clientId, subject, description: dto.description ?? null,
      category: dto.category ?? 'request', status: 'open', priority: (dto.priority ?? 'normal') as any,
      createdBy: userId, createdByName: nameOf(user), createdByRole: 'client',
      assignedToUserId: null, lastMessageAt: new Date(), isDeleted: false,
    }));
    const client = await this.clients.findOne({ where: { id: clientId } });
    const recips = await this.ticketStaffRecipients(clientId, null, userId);
    await this.notifyTicket(orgId, recips, 'client_ticket_created', `New request from ${client?.companyName ?? 'a client'}: ${t.subject}`, t.description ?? '', t.id, `/clients/${clientId}`);
    return this.ticketView(t);
  }

  async portalGetTicket(orgId: string, userId: string, ticketId: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const t = await this.tickets.findOne({ where: { id: ticketId, clientId, organizationId: orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Ticket not found');
    const msgs = await this.ticketMessages.find({ where: { ticketId, organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } });
    return { ticket: this.ticketView(t), messages: msgs.map((m) => this.ticketMessageView(m)) };
  }

  async portalReply(orgId: string, userId: string, ticketId: string, dto: TicketMessageDto) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const t = await this.tickets.findOne({ where: { id: ticketId, clientId, organizationId: orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Ticket not found');
    const body = (dto.body || '').trim();
    if (!body) throw new BadRequestException('Message cannot be empty');
    const user = await this.users.findOne({ where: { id: userId } });
    const m = await this.ticketMessages.save(this.ticketMessages.create({
      organizationId: orgId, ticketId, authorId: userId, authorName: nameOf(user), authorRole: 'client', body, isDeleted: false,
    }));
    t.lastMessageAt = new Date();
    if (t.status === 'resolved' || t.status === 'closed') t.status = 'open'; // a client reply reopens
    await this.tickets.save(t);
    const client = await this.clients.findOne({ where: { id: clientId } });
    const recips = await this.ticketStaffRecipients(clientId, t.assignedToUserId, userId);
    await this.notifyTicket(orgId, recips, 'client_ticket_reply', `Reply from ${client?.companyName ?? 'a client'}: ${t.subject}`, body, t.id, `/clients/${clientId}`);
    return this.ticketMessageView(m);
  }

  // ── agreements (portal) ──────────────────────────────────────────────────────

  /** Agreements sent to the caller's client (drafts are hidden from the portal). */
  async portalAgreements(orgId: string, userId: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const rows = await this.agreements.find({
      where: { clientId, organizationId: orgId, isDeleted: false, status: In(['sent', 'signed']) },
      order: { createdAt: 'DESC' },
    });
    return rows.map((a) => this.agreementView(a));
  }

  async portalAgreement(orgId: string, userId: string, id: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const a = await this.agreements.findOne({ where: { id, clientId, organizationId: orgId, isDeleted: false } });
    if (!a || a.status === 'draft' || a.status === 'void') throw new NotFoundException('Agreement not found');
    return this.agreementView(a);
  }

  /** A portal user signs an agreement (sent → signed) with an audit trail. */
  async signAgreement(orgId: string, userId: string, id: string, dto: SignAgreementDto, ip?: string, ua?: string) {
    const clientId = await this.clientIdForUser(orgId, userId);
    if (!clientId) throw new ForbiddenException('No client portal access');
    const a = await this.agreements.findOne({ where: { id, clientId, organizationId: orgId, isDeleted: false } });
    if (!a || a.status === 'draft' || a.status === 'void') throw new NotFoundException('Agreement not found');
    if (a.status === 'signed') throw new BadRequestException('This agreement is already signed');
    if (!dto.signerName?.trim()) throw new BadRequestException('A signer name is required to sign');
    const now = new Date();
    a.signature = {
      signerName: dto.signerName.trim(),
      signerEmail: null,
      signedByUserId: userId,
      signedAt: now.toISOString(),
      ipAddress: ip ?? null,
      userAgent: ua ?? null,
      method: dto.method || (dto.signatureFileId ? 'drawn' : 'typed'),
      signatureFileId: dto.signatureFileId ?? null,
      fieldValues: (dto.fieldValues || []).reduce<Record<string, string>>((acc, f) => {
        if (f.value != null) acc[f.key] = f.value;
        return acc;
      }, {}),
    };
    a.signedFileId = dto.signedFileId ?? null;
    a.status = 'signed';
    a.signedAt = now;
    await this.agreements.save(a);

    // Notify the sender + the client's delivery team that it's been signed.
    void this.notifyAgreementSigned(a, dto.signerName.trim()).catch(() => undefined);
    return this.agreementView(a);
  }

  /** In-app + email alert to the agreement's creator and the client's assigned staff. */
  private async notifyAgreementSigned(a: ClientAgreementEntity, signerName: string): Promise<void> {
    if (!this.notifier) return;
    const client = await this.clients.findOne({ where: { id: a.clientId } });
    const companyName = client?.companyName ?? 'a client';
    const assigned = await this.assignments.find({ where: { clientId: a.clientId } });
    const recipients = new Set<string>([...(a.createdBy ? [a.createdBy] : []), ...assigned.map((x) => x.userId)]);
    for (const userId of recipients) {
      await this.notifier.notify({
        organizationId: a.organizationId,
        userId,
        type: 'client_agreement_signed',
        title: `${signerName} signed “${a.title}”`,
        body: `${companyName} signed the agreement “${a.title}”.`,
        data: { actionUrl: `/clients/${a.clientId}`, clientId: a.clientId, agreementId: a.id },
        email: EMAIL_OVERRIDES.agreementSigned(companyName, a.title),
      }).catch(() => undefined);
    }
  }

  private agreementView(a: ClientAgreementEntity) {
    return {
      id: a.id, clientId: a.clientId, title: a.title, description: a.description, category: a.category,
      bodyHtml: a.bodyHtml, sourceFileId: a.sourceFileId, fields: a.fields ?? [], signedFileId: a.signedFileId,
      status: a.status, signature: a.signature, sentAt: a.sentAt, signedAt: a.signedAt, createdAt: a.createdAt,
      lastReminderAt: a.lastReminderAt, reminderCount: a.reminderCount ?? 0,
    };
  }
}
