import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  MemberOnboardingEntity,
  OnboardingChecklistSlot,
  OnboardingDocumentSlot,
} from '../entities/member-onboarding.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { PolicyService } from '../../policy/policy.service';
import {
  OnboardingConfig,
  SELF_SERVICE_CHECKLIST_CATEGORIES,
} from '../../policy/onboarding-catalog';
import { MailService } from '../../../bootstrap/mail/mail.service';
import { NotifierService } from '../../notification/notifier.service';
import {
  onboardingReminderEmail,
  onboardingWelcomeEmail,
} from '../../../bootstrap/mail/email-layout';
import { InitiateOnboardingDto } from '../dto';
import { EmailRoutingService } from '../../notification/email-routing.service';

/** The HR-facing onboarding record view (with a rolled-up progress summary). */
export interface OnboardingView {
  id: string;
  organizationId: string;
  membershipId: string;
  userId: string | null;
  employeeName: string | null;
  employeeEmail: string | null;
  status: string;
  role: string | null;
  roleId: string | null;
  departmentId: string | null;
  reportingManagerId: string | null;
  startDate: Date | null;
  targetDate: Date | null;
  probationMonths: number | null;
  probationEndDate: Date | null;
  documents: OnboardingDocumentSlot[];
  checklist: OnboardingChecklistSlot[];
  progress: OnboardingProgress;
  createdAt: Date;
  completedAt: Date | null;
}

export interface OnboardingProgress {
  documentsTotal: number;
  documentsUploaded: number;
  documentsVerified: number;
  checklistTotal: number;
  checklistDone: number;
  /** 0–100, verified docs + done tasks over the total. */
  percent: number;
  outstanding: number;
}

const ACTIVE_STATUSES = ['pending', 'in_progress', 'completed'];

/**
 * OnboardingLifecycleService — the employee onboarding lifecycle. In Nexora the
 * person IS the `OrgMembership`, so a record attaches to a membership. Its
 * document + checklist requirements are seeded from the org's onboarding POLICY
 * config and reconciled-on-read as that policy changes.
 *
 * HR initiates + verifies; the hire self-serves uploads + welcome tasks. Notices
 * go out both by email (MailService) and as in-app notifications to the hire
 * (NotifierService: onboarding started / document approved / rejected).
 */
@Injectable()
export class OnboardingLifecycleService {
  private readonly logger = new Logger(OnboardingLifecycleService.name);

  constructor(
    @InjectRepository(MemberOnboardingEntity)
    private readonly repo: Repository<MemberOnboardingEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    private readonly policy: PolicyService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly notifier: NotifierService,
    private readonly emailRouting: EmailRoutingService,
  ) {}

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3111'
    ).replace(/\/$/, '');
  }

  // ── initiate ────────────────────────────────────────────────────────────────

  /**
   * Resolve the target membership from the DTO's `membershipId` (which may be a
   * membership id OR the member's userId — the Directory only holds userId).
   */
  private async resolveMembership(
    orgId: string,
    idOrUserId: string,
  ): Promise<OrgMembershipEntity> {
    let m = await this.memberships.findOne({
      where: { id: idOrUserId, organizationId: orgId },
    });
    if (!m) {
      m = await this.memberships.findOne({
        where: { userId: idOrUserId, organizationId: orgId },
      });
    }
    if (!m) throw new NotFoundException('Member not found in this organization');
    return m;
  }

  private async memberName(m: OrgMembershipEntity): Promise<string | null> {
    if (!m.userId) return m.email;
    const u = await this.users.findOne({ where: { id: m.userId } });
    if (!u) return m.email;
    return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
  }

  private seedDocuments(cfg: OnboardingConfig): OnboardingDocumentSlot[] {
    return cfg.documents.map((d) => ({
      key: d.key,
      title: d.title,
      required: d.required,
      status: 'pending',
      fileId: null,
    }));
  }

  private seedChecklist(cfg: OnboardingConfig): OnboardingChecklistSlot[] {
    return cfg.checklist.map((c) => ({
      key: c.key,
      title: c.title,
      category: c.category,
      assignedTo: c.assignedTo,
      status: 'pending',
    }));
  }

  async initiate(
    orgId: string,
    dto: InitiateOnboardingDto,
    actorUserId: string,
  ): Promise<OnboardingView> {
    const membership = await this.resolveMembership(orgId, dto.membershipId);

    // Supersede any prior CANCELLED onboarding for this member (a failed hire can
    // be re-onboarded) — but block a duplicate active one.
    const existing = await this.repo.find({
      where: { organizationId: orgId, membershipId: membership.id, isDeleted: false },
    });
    const active = existing.find((r) => ACTIVE_STATUSES.includes(r.status));
    if (active) {
      throw new BadRequestException(
        'This member already has an onboarding in progress',
      );
    }
    for (const stale of existing.filter((r) => r.status === 'cancelled')) {
      stale.isDeleted = true;
      await this.repo.save(stale);
    }

    const cfg = await this.policy.getOnboardingConfig(orgId);
    const start = dto.startDate ? new Date(dto.startDate) : new Date();
    const probationMonths =
      typeof dto.probationMonths === 'number'
        ? dto.probationMonths
        : cfg.defaultProbationMonths;
    const targetDays = dto.targetDays ?? cfg.targetDays;

    const probationEndDate =
      probationMonths > 0 ? this.addMonths(start, probationMonths) : null;
    const targetDate = this.addDays(start, targetDays);

    const name = await this.memberName(membership);
    const record = await this.repo.save(
      this.repo.create({
        organizationId: orgId,
        membershipId: membership.id,
        userId: membership.userId,
        employeeEmail: membership.email,
        employeeName: name,
        status: 'pending',
        role: membership.role,
        roleId: membership.roleId,
        departmentId: membership.departmentId,
        reportingManagerId: dto.reportingManagerId ?? null,
        startDate: start,
        targetDate,
        probationMonths,
        probationEndDate,
        documents: this.seedDocuments(cfg),
        checklist: this.seedChecklist(cfg),
        initiatedBy: actorUserId,
      }),
    );

    await this.sendWelcomeEmail(record);
    await this.notifier.notify({
      organizationId: orgId,
      userId: record.userId ?? '',
      actorId: actorUserId,
      type: 'onboarding_initiated',
      title: 'Your onboarding has started',
      body: 'Complete your checklist and upload the required documents to get set up.',
      data: { actionUrl: '/onboarding/me', onboardingId: record.id },
    });
    return this.toView(record);
  }

  private addMonths(date: Date, months: number): Date {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
  }

  private addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  private async sendWelcomeEmail(record: MemberOnboardingEntity): Promise<void> {
    if (!record.employeeEmail) return;
    if (!(await this.hireReceives(record, 'onboarding.welcome'))) return;
    const { subject, html } = onboardingWelcomeEmail({
      employeeName: record.employeeName,
      orgName: await this.orgNameFor(record.organizationId),
      documentTitles: record.documents.map((d) => d.title),
      taskTitles: record.checklist.map((c) => c.title),
      onboardingUrl: `${this.frontendUrl()}/onboarding/me`,
    });
    await this.mail.send({
      to: record.employeeEmail,
      subject,
      html,
      category: 'onboarding.welcome',
      organizationId: record.organizationId,
    });
  }

  /**
   * The org's per-role choice for a new-hire email, keyed off the hire's
   * membership (they may not have signed in yet, so there's no user to look up).
   * Fails open.
   */
  private async hireReceives(record: MemberOnboardingEntity, key: string): Promise<boolean> {
    try {
      const m = await this.memberships.findOne({ where: { id: record.membershipId } });
      if (!m) return true;
      return (await this.emailRouting.forOrg(record.organizationId)).allowsMember(key, m);
    } catch {
      return true;
    }
  }

  private async orgNameFor(orgId: string): Promise<string> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    return org?.name || 'your team';
  }

  // ── HR: read / manage ─────────────────────────────────────────────────────────

  async list(orgId: string): Promise<OnboardingView[]> {
    const rows = await this.repo.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    // Reconcile in-progress records against the live policy once (shared cfg).
    const cfg = await this.policy.getOnboardingConfig(orgId);
    for (const r of rows) await this.reconcile(r, cfg);
    return rows.map((r) => this.toView(r));
  }

  private async getRecord(orgId: string, id: string): Promise<MemberOnboardingEntity> {
    const r = await this.repo.findOne({
      where: { id, organizationId: orgId, isDeleted: false },
    });
    if (!r) throw new NotFoundException('Onboarding record not found');
    return r;
  }

  async get(orgId: string, id: string): Promise<OnboardingView> {
    const r = await this.getRecord(orgId, id);
    await this.reconcile(r, await this.policy.getOnboardingConfig(orgId));
    return this.toView(r);
  }

  /** membershipIds with an active (non-cancelled) onboarding — the picker filter. */
  async activeMembershipIds(orgId: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { organizationId: orgId, isDeleted: false },
    });
    return [
      ...new Set(
        rows
          .filter((r) => ACTIVE_STATUSES.includes(r.status))
          .map((r) => r.membershipId),
      ),
    ];
  }

  async verifyDocument(
    orgId: string,
    id: string,
    key: string,
    actorUserId: string,
  ): Promise<OnboardingView> {
    const r = await this.getRecord(orgId, id);
    const slot = r.documents.find((d) => d.key === key);
    if (!slot) throw new NotFoundException('Document not found on this onboarding');
    if (slot.status !== 'uploaded') {
      throw new BadRequestException('Only an uploaded document can be verified');
    }
    slot.status = 'verified';
    slot.verifiedAt = new Date().toISOString();
    slot.verifiedBy = actorUserId;
    slot.note = null;
    r.documents = [...r.documents];
    await this.repo.save(r);
    await this.notifier.notify({
      organizationId: orgId,
      userId: r.userId ?? '',
      actorId: actorUserId,
      type: 'onboarding_document_verified',
      title: 'Onboarding document approved',
      body: `Your "${slot.title}" was approved.`,
      data: { actionUrl: '/onboarding/me', onboardingId: r.id, documentKey: key },
    });
    return this.toView(r);
  }

  async rejectDocument(
    orgId: string,
    id: string,
    key: string,
    note: string,
    actorUserId: string,
  ): Promise<OnboardingView> {
    const r = await this.getRecord(orgId, id);
    const slot = r.documents.find((d) => d.key === key);
    if (!slot) throw new NotFoundException('Document not found on this onboarding');
    if (slot.status !== 'uploaded') {
      throw new BadRequestException('Only an uploaded document can be rejected');
    }
    slot.status = 'rejected';
    slot.verifiedBy = actorUserId;
    slot.verifiedAt = new Date().toISOString();
    slot.note = note;
    r.documents = [...r.documents];
    await this.repo.save(r);
    await this.notifier.notify({
      organizationId: orgId,
      userId: r.userId ?? '',
      actorId: actorUserId,
      type: 'onboarding_document_rejected',
      title: 'Onboarding document needs changes',
      body: `Your "${slot.title}" was rejected${note ? `: ${note}` : ''}. Please re-upload it.`,
      data: { actionUrl: '/onboarding/me', onboardingId: r.id, documentKey: key },
      priority: 'high',
    });
    return this.toView(r);
  }

  /**
   * HR requests an additional (ad-hoc) document FROM an employee. Appends a new
   * document slot to their onboarding record; the employee sees it in "My
   * Onboarding" and uploads it, HR verifies it with the same flow as a policy
   * document. Reachable from the Onboarding page (by record id).
   */
  async requestDocument(
    orgId: string,
    id: string,
    input: { title: string; required?: boolean; description?: string | null },
    actorUserId: string,
  ): Promise<OnboardingView> {
    const r = await this.getRecord(orgId, id);
    this.appendAdhocDocument(r, input, actorUserId);
    if (r.status === 'pending') r.status = 'in_progress';
    await this.repo.save(r);
    await this.notifyDocumentRequested(orgId, r, input.title, actorUserId);
    return this.toView(r);
  }

  /**
   * HR requests a document from an employee by MEMBERSHIP (from the Directory,
   * where the caller has a person, not an onboarding record). Appends to the
   * member's active onboarding, or opens a lightweight document-request record
   * so it still surfaces in their "My Onboarding".
   */
  async requestDocumentForMembership(
    orgId: string,
    membershipId: string,
    input: { title: string; required?: boolean; description?: string | null },
    actorUserId: string,
  ): Promise<OnboardingView> {
    const m = await this.resolveMembership(orgId, membershipId);
    let r = m.userId ? await this.myRecord(orgId, m.userId) : null;
    if (!r) {
      // No active onboarding — open a minimal record that only carries the
      // requested document(s), so the employee gets a "documents to provide"
      // view without re-running their whole onboarding checklist.
      r = this.repo.create({
        organizationId: orgId,
        membershipId: m.id,
        userId: m.userId ?? null,
        employeeEmail: m.email ?? null,
        employeeName: await this.memberName(m),
        status: 'in_progress',
        roleId: m.roleId ?? null,
        role: m.role ?? null,
        departmentId: (m as any).departmentId ?? null,
        documents: [],
        checklist: [],
        initiatedBy: actorUserId,
      });
    }
    this.appendAdhocDocument(r, input, actorUserId);
    if (r.status === 'pending') r.status = 'in_progress';
    await this.repo.save(r);
    await this.notifyDocumentRequested(orgId, r, input.title, actorUserId);
    return this.toView(r);
  }

  /** Append an ad-hoc document slot with a unique, human-derived key. */
  private appendAdhocDocument(
    r: MemberOnboardingEntity,
    input: { title: string; required?: boolean; description?: string | null },
    actorUserId: string,
  ): void {
    const title = (input.title ?? '').trim();
    if (!title) throw new BadRequestException('A document title is required');
    const base =
      'adhoc_' +
      (title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 30) || 'document');
    const used = new Set(r.documents.map((d) => d.key));
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}_${n++}`;
    r.documents = [
      ...r.documents,
      {
        key,
        title,
        required: input.required !== false,
        status: 'pending',
        fileId: null,
        adhoc: true,
        description: input.description?.trim() || null,
        requestedBy: actorUserId,
        requestedAt: new Date().toISOString(),
      },
    ];
  }

  private async notifyDocumentRequested(
    orgId: string,
    r: MemberOnboardingEntity,
    title: string,
    actorUserId: string,
  ): Promise<void> {
    if (!r.userId) return;
    await this.notifier.notify({
      organizationId: orgId,
      userId: r.userId,
      actorId: actorUserId,
      type: 'onboarding_document_requested',
      title: 'A document was requested from you',
      body: `Please provide "${title}" in My Onboarding.`,
      data: { actionUrl: '/onboarding/me', onboardingId: r.id },
      priority: 'high',
    });
  }

  async complete(orgId: string, id: string): Promise<OnboardingView> {
    const r = await this.getRecord(orgId, id);
    if (r.status === 'completed') return this.toView(r);
    r.status = 'completed';
    r.completedAt = new Date();
    await this.repo.save(r);
    return this.toView(r);
  }

  async cancel(orgId: string, id: string): Promise<OnboardingView> {
    const r = await this.getRecord(orgId, id);
    r.status = 'cancelled';
    await this.repo.save(r);
    return this.toView(r);
  }

  // ── employee self-service ─────────────────────────────────────────────────────

  private async myRecord(orgId: string, userId: string): Promise<MemberOnboardingEntity | null> {
    const rows = await this.repo.find({
      where: { organizationId: orgId, userId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    return rows.find((r) => ACTIVE_STATUSES.includes(r.status)) || null;
  }

  async getMyOnboarding(orgId: string, userId: string): Promise<OnboardingView | null> {
    const r = await this.myRecord(orgId, userId);
    if (!r) return null;
    await this.reconcile(r, await this.policy.getOnboardingConfig(orgId));
    // Probation is an HR-internal detail — never expose it to the member on
    // their own onboarding view. It stays visible on the HR/directory surfaces.
    return { ...this.toView(r), probationMonths: null, probationEndDate: null };
  }

  async uploadMyDocument(
    orgId: string,
    userId: string,
    key: string,
    fileId: string,
  ): Promise<OnboardingView> {
    const r = await this.myRecord(orgId, userId);
    if (!r) throw new NotFoundException('You have no active onboarding');
    const slot = r.documents.find((d) => d.key === key);
    if (!slot) throw new NotFoundException('That document is not part of your onboarding');
    slot.status = 'uploaded';
    slot.fileId = fileId;
    slot.uploadedAt = new Date().toISOString();
    slot.note = null;
    r.documents = [...r.documents];
    if (r.status === 'pending') r.status = 'in_progress';
    await this.repo.save(r);
    return this.toView(r);
  }

  async completeMyChecklistItem(
    orgId: string,
    userId: string,
    key: string,
  ): Promise<OnboardingView> {
    const r = await this.myRecord(orgId, userId);
    if (!r) throw new NotFoundException('You have no active onboarding');
    const item = r.checklist.find((c) => c.key === key);
    if (!item) throw new NotFoundException('That task is not part of your onboarding');
    // A hire may only complete tasks assigned to them OR in a self-serviceable
    // category — never IT/compliance tasks a privileged member must do.
    const selfServiceable =
      item.assignedTo === 'self' ||
      SELF_SERVICE_CHECKLIST_CATEGORIES.includes(item.category as any);
    if (!selfServiceable) {
      throw new ForbiddenException('This task is completed by HR or IT');
    }
    item.status = 'done';
    item.completedAt = new Date().toISOString();
    item.completedBy = userId;
    r.checklist = [...r.checklist];
    if (r.status === 'pending') r.status = 'in_progress';
    await this.repo.save(r);
    return this.toView(r);
  }

  /**
   * HR/manager marks (or re-opens) ANY checklist item on a hire's onboarding —
   * including the IT-owned and HR-owned tasks the hire can't self-serve
   * ("Provision IT accounts", "Set up workstation", "Schedule team introduction").
   * This is who actually ticks the `assignedTo: 'it' | 'hr'` tasks. Guarded at the
   * controller (owner/admin/HR with employees:edit).
   */
  async setChecklistItemStatus(
    orgId: string,
    id: string,
    key: string,
    done: boolean,
    actorUserId: string,
  ): Promise<OnboardingView> {
    const r = await this.getRecord(orgId, id);
    if (r.status === 'completed' || r.status === 'cancelled') {
      throw new BadRequestException('This onboarding is closed');
    }
    const item = r.checklist.find((c) => c.key === key);
    if (!item) throw new NotFoundException('That task is not part of this onboarding');
    if (done) {
      item.status = 'done';
      item.completedAt = new Date().toISOString();
      item.completedBy = actorUserId;
    } else {
      item.status = 'pending';
      item.completedAt = null;
      item.completedBy = null;
    }
    r.checklist = [...r.checklist];
    if (r.status === 'pending') r.status = 'in_progress';
    await this.repo.save(r);
    return this.toView(r);
  }

  // ── reconcile-on-read ─────────────────────────────────────────────────────────

  /**
   * Bring a record's documents into line with the live policy config: ADD docs
   * newly required, REMOVE docs no longer in the policy UNLESS already submitted
   * (never discard uploaded/verified work), refresh title/required, and order to
   * the policy. Skips completed/cancelled records (historical). Persists only when
   * something changed.
   */
  private async reconcile(
    r: MemberOnboardingEntity,
    cfg: OnboardingConfig,
  ): Promise<void> {
    if (r.status === 'completed' || r.status === 'cancelled') return;
    const byKey = new Map(r.documents.map((d) => [d.key, d]));
    const cfgKeys = new Set(cfg.documents.map((d) => d.key));
    const next: OnboardingDocumentSlot[] = [];
    let changed = false;

    for (const c of cfg.documents) {
      const slot = byKey.get(c.key);
      if (slot) {
        if (slot.title !== c.title || slot.required !== c.required) {
          slot.title = c.title;
          slot.required = c.required;
          changed = true;
        }
        next.push(slot);
      } else {
        next.push({ key: c.key, title: c.title, required: c.required, status: 'pending', fileId: null });
        changed = true;
      }
    }
    // Keep any already-submitted doc that the policy dropped (never lose work),
    // and ALWAYS keep ad-hoc requests (an HR-requested doc that isn't in the
    // policy) even while still pending — those aren't policy noise to prune.
    for (const slot of r.documents) {
      if (cfgKeys.has(slot.key)) continue; // already carried over above
      if (slot.adhoc || slot.status !== 'pending') {
        next.push(slot);
      } else {
        changed = true; // a pending policy doc the policy removed → drop it
      }
    }
    // Auto-complete the "Complete your profile" self task once the member has
    // filled their core profile (name + role + phone). Self-heals on any read of
    // the record (My Onboarding or the HR list), so saving the profile in
    // Settings satisfies the checklist without a manual "Mark done".
    const profileTask = (r.checklist || []).find((c) => c.key === 'profile_complete');
    if (profileTask && profileTask.status !== 'done' && r.userId) {
      const user = await this.users.findOne({ where: { id: r.userId } });
      if (user && this.isProfileComplete(user, cfg.profileFields)) {
        profileTask.status = 'done';
        profileTask.completedAt = new Date().toISOString();
        profileTask.completedBy = r.userId;
        r.checklist = [...r.checklist];
        if (r.status === 'pending') r.status = 'in_progress';
        changed = true;
      }
    }

    // Auto-complete the "Acknowledge company policies" self task once the member
    // has nothing left to acknowledge — i.e. they've accepted every applicable
    // acknowledgement-required policy, OR none apply to them at all. Mirrors the
    // profile task: acknowledging in Policies (or the login gate) satisfies the
    // checklist without a manual "Mark done".
    const policyTask = (r.checklist || []).find((c) => c.key === 'policies_ack');
    if (policyTask && policyTask.status !== 'done' && r.userId && r.organizationId) {
      const pending = await this.policy.pendingAcknowledgements(r.organizationId, r.userId);
      if (pending.length === 0) {
        policyTask.status = 'done';
        policyTask.completedAt = new Date().toISOString();
        policyTask.completedBy = r.userId;
        r.checklist = [...r.checklist];
        if (r.status === 'pending') r.status = 'in_progress';
        changed = true;
      }
    }

    if (changed || next.length !== r.documents.length) {
      r.documents = next;
      await this.repo.save(r);
    }
  }

  /**
   * The bar for the `profile_complete` onboarding task: a real name (always) PLUS
   * every profile field the OWNER configured as required (`cfg.profileFields`,
   * managed from Settings → Onboarding). An empty required-list means name alone.
   */
  private isProfileComplete(u: UserEntity, requiredFields: string[] = []): boolean {
    if (!u.firstName?.trim() || !u.lastName?.trim()) return false;
    for (const key of requiredFields) {
      const v = (u as unknown as Record<string, unknown>)[key];
      if (typeof v !== 'string' || !v.trim()) return false;
    }
    return true;
  }

  // ── daily reminder ────────────────────────────────────────────────────────────

  /**
   * Nudge hires with outstanding onboarding items. 10:00 daily. Sends BOTH an
   * email (when the hire has an address) AND an in-app notification (when the
   * hire has a linked user) so the reminder also lands in their inbox and can be
   * tapped through to `/onboarding/me`. Either channel firing stamps
   * `lastReminderAt`.
   */
  @Cron('0 10 * * *')
  async remindPending(): Promise<void> {
    const rows = await this.repo.find({
      where: { isDeleted: false },
    });
    const active = rows.filter((r) => ACTIVE_STATUSES.includes(r.status) && r.status !== 'completed');
    for (const r of active) {
      const pending = this.outstandingTitles(r);
      if (!pending.length) continue;

      let notified = false;

      if (r.employeeEmail && (await this.hireReceives(r, 'onboarding.reminder'))) {
        const { subject, html } = onboardingReminderEmail({
          employeeName: r.employeeName,
          orgName: await this.orgNameFor(r.organizationId),
          pendingTitles: pending,
          onboardingUrl: `${this.frontendUrl()}/onboarding/me`,
        });
        const ok = await this.mail.send({
          to: r.employeeEmail,
          subject,
          html,
          category: 'onboarding.reminder',
          organizationId: r.organizationId,
        });
        notified = notified || ok;
      }

      // In-app reminder — system-generated (no actor), routes to My Onboarding.
      if (r.userId) {
        const count = pending.length;
        await this.notifier.notify({
          organizationId: r.organizationId,
          userId: r.userId,
          type: 'onboarding_reminder',
          title: 'Onboarding items still pending',
          body:
            count === 1
              ? `You still have 1 item to finish: ${pending[0]}.`
              : `You still have ${count} onboarding items to finish, starting with "${pending[0]}".`,
          data: { actionUrl: '/onboarding/me', onboardingId: r.id, pendingCount: count },
        });
        notified = true;
      }

      if (notified) {
        r.lastReminderAt = new Date();
        await this.repo.save(r);
      }
    }
  }

  private outstandingTitles(r: MemberOnboardingEntity): string[] {
    const docs = r.documents
      .filter((d) => d.required && d.status !== 'verified' && d.status !== 'uploaded')
      .map((d) => d.title);
    const tasks = r.checklist
      .filter((c) => c.status !== 'done' && (c.assignedTo === 'self' || SELF_SERVICE_CHECKLIST_CATEGORIES.includes(c.category as any)))
      .map((c) => c.title);
    return [...docs, ...tasks];
  }

  // ── views ─────────────────────────────────────────────────────────────────────

  private progress(r: MemberOnboardingEntity): OnboardingProgress {
    const documentsTotal = r.documents.length;
    const documentsUploaded = r.documents.filter(
      (d) => d.status === 'uploaded' || d.status === 'verified',
    ).length;
    const documentsVerified = r.documents.filter((d) => d.status === 'verified').length;
    const checklistTotal = r.checklist.length;
    const checklistDone = r.checklist.filter((c) => c.status === 'done').length;
    const denom = documentsTotal + checklistTotal;
    const done = documentsVerified + checklistDone;
    const percent = denom === 0 ? 100 : Math.round((done / denom) * 100);
    const outstanding =
      r.documents.filter((d) => d.required && d.status !== 'verified').length +
      r.checklist.filter((c) => c.status !== 'done').length;
    return {
      documentsTotal,
      documentsUploaded,
      documentsVerified,
      checklistTotal,
      checklistDone,
      percent,
      outstanding,
    };
  }

  private toView(r: MemberOnboardingEntity): OnboardingView {
    return {
      id: r.id,
      organizationId: r.organizationId,
      membershipId: r.membershipId,
      userId: r.userId,
      employeeName: r.employeeName,
      employeeEmail: r.employeeEmail,
      status: r.status,
      role: r.role,
      roleId: r.roleId,
      departmentId: r.departmentId,
      reportingManagerId: r.reportingManagerId,
      startDate: r.startDate,
      targetDate: r.targetDate,
      probationMonths: r.probationMonths,
      probationEndDate: r.probationEndDate,
      documents: r.documents,
      checklist: r.checklist,
      progress: this.progress(r),
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }
}
