import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { staffScope } from '../../auth/entities/person-type';
import { VendorEntity } from '../../vendors/entities/vendor.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { RoleEntity } from '../../auth/entities/role.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { AddMemberDto } from '../dto';
import { ROLE_NAME_TO_TIER } from '../default-roles';
import { OrgLimitsService } from './org-limits.service';
import { MailService } from '../../../bootstrap/mail/mail.service';
import { MemberOnboardingEntity } from '../../onboarding/entities/member-onboarding.entity';
import { emailChangedNoticeEmail } from '../../../bootstrap/mail/email-layout';

export interface MemberView {
  membershipId: string;
  /**
   * `staff` for the org's own people; `vendor` for a contractor a vendor
   * supplies, who is a secondary member — in the Directory, but never in
   * payroll, the attendance roster, seat counts or leave.
   */
  personType?: string;
  /** The vendor supplying this person, when they are a secondary member. */
  suppliedBy?: { vendorId: string; companyName: string } | null;
  userId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  roleId: string | null;
  secondaryRoleId: string | null;
  departmentId: string | null;
  status: string;
  joinedAt: Date | null;
  // Profile + HR attributes (for the member detail view).
  avatar: string | null;
  phoneNumber: string | null;
  /**
   * Job title in THIS org, or null when none is set. Deliberately NOT merged
   * with `jobTitle`: a caller has to be able to tell an org title from the
   * person's own profile title (the Directory shows the latter as placeholder
   * text, so editing the field can't silently promote it into an org title).
   */
  title: string | null;
  jobTitle: string | null;
  location: string | null;
  timezone: string | null;
  dateOfBirth: Date | null;
  employeeCode: string | null;
  employmentType: string | null;
  joiningDate: Date | null;
  // Submitted HR documents (member-onboarding slots that have a file), populated
  // on the detail view so the directory can show/download them.
  documents?: MemberDocumentView[];
  // Probation status — HR-only, shown on the directory detail (never exposed to
  // the member themselves). Null when the member is not/never on probation.
  probation?: MemberProbationView | null;
}

export interface MemberDocumentView {
  key: string;
  title: string;
  status: string;
  fileId: string;
  uploadedAt: string | null;
}

export interface MemberProbationView {
  onProbation: boolean; // true while today <= endDate
  months: number | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Team membership — the people half of org setup. Adding a member resolves (or
 * creates) the user, then attaches an active org membership carrying the
 * enforced tier, optional custom role, and department. Scoped to the acting
 * `orgId` throughout.
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectRepository(OrgMembershipEntity)
    private readonly membershipRepo: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly orgRepo: Repository<OrganizationEntity>,
    @InjectRepository(MemberOnboardingEntity)
    private readonly onboardingRepo: Repository<MemberOnboardingEntity>,
    private readonly limits: OrgLimitsService,
    private readonly mail: MailService,
  ) {}

  /**
   * Resolve the enforced tier + validated custom role for a new/updated member.
   * A custom role (`roleId`) scoped to a department may only be assigned to a
   * member of that same department (the department↔role relation). When no tier
   * is given, it's derived from the custom role (else defaults to `employee`).
   */
  private async resolveRole(
    orgId: string,
    input: { role?: string; roleId?: string; departmentId?: string },
  ): Promise<{ tier: string; roleId: string | null; departmentId: string | null }> {
    // No custom role picked → the member holds just the tier, with no role row.
    // There are no built-in tier roles to attach any more, and a lookup by
    // (tier, isSystem) would be actively wrong: the education pack's built-in
    // roles carry tiers too, so it could hand an admin the "Principal" role.
    if (!input.roleId) {
      return {
        tier: input.role || 'employee',
        roleId: null,
        departmentId: input.departmentId ?? null,
      };
    }
    const role = await this.roleRepo.findOne({
      where: { id: input.roleId, organizationId: orgId, isDeleted: false },
    });
    if (!role) throw new NotFoundException('Role not found for this organization');
    if (
      role.departmentId &&
      input.departmentId &&
      role.departmentId !== input.departmentId
    ) {
      throw new BadRequestException(
        'That role belongs to a different department than this member. ' +
          'Pick a role from the same department (or an org-wide role).',
      );
    }
    // Tier is DERIVED from the assigned role (its `tier`, then legacy name map).
    const tier = role.tier || ROLE_NAME_TO_TIER[role.name] || input.role || 'employee';
    // A department-scoped role coherently places the member in that department
    // (an explicit departmentId wins; validated equal above).
    const departmentId = input.departmentId ?? role.departmentId ?? null;
    return { tier, roleId: role.id, departmentId };
  }

  async addMember(
    orgId: string,
    dto: AddMemberDto,
    invitedBy: string,
  ): Promise<MemberView> {
    const email = dto.email.toLowerCase();

    let user = await this.userRepo.findOne({ where: { email } });
    if (!user) {
      user = await this.userRepo.save(
        this.userRepo.create({
          email,
          password: 'pending-otp-' + randomUUID(),
          firstName: dto.firstName || 'Member',
          lastName: dto.lastName || '',
          isActive: true,
          setupStage: 'complete',
        }),
      );
    }

    const existing = await this.membershipRepo.findOne({
      where: { organizationId: orgId, userId: user.id },
    });
    if (existing) {
      throw new ConflictException('This person is already a member of the organization');
    }

    // Seat cap (super-admin allocation): a genuinely NEW member must fit under
    // the org's member limit. Re-adds hit the conflict above and never count.
    await this.limits.assertSeatAvailable(orgId);

    // Resolve the enforced tier from the (optional) custom role + validate the
    // department↔role relation before writing the membership.
    const resolved = await this.resolveRole(orgId, {
      role: dto.role,
      roleId: dto.roleId,
      departmentId: dto.departmentId,
    });

    const membership = await this.membershipRepo.save(
      this.membershipRepo.create({
        userId: user.id,
        email,
        organizationId: orgId,
        role: resolved.tier,
        roleId: resolved.roleId,
        departmentId: resolved.departmentId,
        status: 'active',
        invitedBy,
        joinedAt: new Date(),
      }),
    );

    // Reflect the org on the user's denormalized list.
    const orgs = new Set(user.organizations || []);
    orgs.add(orgId);
    user.organizations = [...orgs];
    if (!user.defaultOrganizationId) user.defaultOrganizationId = orgId;
    await this.userRepo.save(user);

    return this.toView(membership, user);
  }

  /**
   * The org directory.
   *
   * staffScope by default: this is the STAFF roster, and students/guardians (the
   * education vertical) live in the same table but are enumerated through their
   * own surfaces. `includeSecondary` additionally returns the contractors a
   * vendor supplies — people who work here without being employed here. They are
   * badged with their vendor and are still excluded everywhere staffScope is
   * used: payroll, the attendance roster, seat counts, leave.
   */
  async list(orgId: string, opts: { includeSecondary?: boolean } = {}): Promise<MemberView[]> {
    const memberships = opts.includeSecondary
      ? await this.membershipRepo.find({
          where: [
            staffScope({ organizationId: orgId }),
            { organizationId: orgId, personType: 'vendor' },
          ],
          order: { createdAt: 'ASC' },
        })
      : await this.membershipRepo.find({
          where: staffScope({ organizationId: orgId }),
          order: { createdAt: 'ASC' },
        });
    // Default ordering: active (and any non-deactivated) members first, then
    // deactivated ones at the bottom. Stable sort preserves join order within
    // each group (Array.prototype.sort is stable in modern Node).
    const isDeactivated = (s: string) => s === 'deactivated';
    memberships.sort(
      (a, b) => Number(isDeactivated(a.status)) - Number(isDeactivated(b.status)),
    );
    const userIds = memberships.map((m) => m.userId).filter(Boolean) as string[];
    const users = userIds.length
      ? await this.userRepo.find({ where: { id: In(userIds) } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    // Name the vendor behind each secondary member, so the Directory can say
    // "Supplied by Acme" rather than showing an unexplained outsider.
    const vendorIds = [...new Set(memberships.map((m) => m.vendorId).filter(Boolean) as string[])];
    const vendors = vendorIds.length
      ? await this.membershipRepo.manager.find(VendorEntity, { where: { id: In(vendorIds) } })
      : [];
    const vendorById = new Map(vendors.map((v) => [v.id, v]));

    return memberships.map((m) => {
      const view = this.toView(m, m.userId ? byId.get(m.userId) : undefined);
      view.personType = m.personType;
      const vendor = m.vendorId ? vendorById.get(m.vendorId) : undefined;
      view.suppliedBy = vendor ? { vendorId: vendor.id, companyName: vendor.companyName } : null;
      return view;
    });
  }

  async get(orgId: string, membershipId: string): Promise<MemberView> {
    const m = await this.membershipRepo.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!m) throw new NotFoundException('Member not found');
    const user = m.userId
      ? await this.userRepo.findOne({ where: { id: m.userId } })
      : null;
    const view = this.toView(m, user || undefined);
    await this.attachOnboarding(orgId, membershipId, view);
    return view;
  }

  /**
   * Enrich a MemberView with the member's HR documents + probation, both derived
   * from the one member-onboarding record. HR-only surface (the directory
   * detail); never returned to the member's own onboarding view.
   */
  private async attachOnboarding(
    orgId: string,
    membershipId: string,
    view: MemberView,
  ): Promise<void> {
    const onboarding = await this.onboardingRepo.findOne({
      where: { organizationId: orgId, membershipId },
    });
    view.documents = (onboarding?.documents || [])
      .filter((d) => d.fileId)
      .map((d) => ({
        key: d.key,
        title: d.title,
        status: d.status,
        fileId: d.fileId as string,
        uploadedAt: d.uploadedAt ? new Date(d.uploadedAt).toISOString() : null,
      }));
    const end = onboarding?.probationEndDate ? new Date(onboarding.probationEndDate) : null;
    view.probation = end
      ? {
          onProbation: end.getTime() >= Date.now(),
          months: onboarding?.probationMonths ?? null,
          startDate: onboarding?.startDate ? new Date(onboarding.startDate).toISOString() : null,
          endDate: end.toISOString(),
        }
      : null;
  }

  /**
   * Put a member on probation for `months` (from their joining date), or clear
   * it when `months` is 0/null. Upserts the member-onboarding record.
   */
  private async setProbation(
    orgId: string,
    m: OrgMembershipEntity,
    months: number | null,
    actorUserId?: string,
  ): Promise<void> {
    let onboarding = await this.onboardingRepo.findOne({
      where: { organizationId: orgId, membershipId: m.id },
    });
    if (!months || months <= 0) {
      if (onboarding) {
        onboarding.probationMonths = null;
        onboarding.probationEndDate = null;
        await this.onboardingRepo.save(onboarding);
      }
      return;
    }
    const start = m.joiningDate ? new Date(m.joiningDate) : new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    if (!onboarding) {
      const user = m.userId ? await this.userRepo.findOne({ where: { id: m.userId } }) : null;
      onboarding = this.onboardingRepo.create({
        organizationId: orgId,
        membershipId: m.id,
        userId: m.userId ?? null,
        employeeEmail: m.email ?? user?.email ?? null,
        employeeName: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null : null,
        status: 'completed',
        documents: [],
        checklist: [],
        startDate: start,
        probationMonths: months,
        probationEndDate: end,
        initiatedBy: actorUserId ?? null,
      });
    } else {
      onboarding.probationMonths = months;
      onboarding.probationEndDate = end;
      if (!onboarding.startDate) onboarding.startDate = start;
    }
    await this.onboardingRepo.save(onboarding);
  }

  /**
   * Titles already in use in this org, for the Directory's title autocomplete.
   * Suggestions keep spellings consistent ("Senior Engineer" vs "Sr. Engineer")
   * without forcing a managed list — a genuinely new title can still be typed.
   * Same staff scope as {@link list}, so students/guardians never contribute.
   */
  async titlesInUse(orgId: string): Promise<string[]> {
    const memberships = await this.membershipRepo.find({
      where: staffScope({ organizationId: orgId }),
    });
    const titles = memberships.map((m) => m.title);
    // Members with no org title fall back to their own profile job title, so
    // those count as "in use" too.
    const needFallback = memberships
      .filter((m) => !m.title?.trim() && m.userId)
      .map((m) => m.userId as string);
    if (needFallback.length) {
      const users = await this.userRepo.find({ where: { id: In(needFallback) } });
      titles.push(...users.map((u) => u.jobTitle));
    }
    // De-duplicate case-insensitively, keeping the first spelling seen.
    const seen = new Map<string, string>();
    for (const raw of titles) {
      const t = (raw ?? '').trim();
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  async updateMember(
    orgId: string,
    membershipId: string,
    patch: {
      role?: string;
      roleId?: string | null;
      departmentId?: string | null;
      status?: 'active' | 'deactivated';
      probationMonths?: number | null;
      title?: string | null;
    },
    actorUserId?: string,
  ): Promise<MemberView> {
    const m = await this.membershipRepo.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!m) throw new NotFoundException('Member not found');
    const prevTier = m.role;

    // Temporary disable / re-enable (org-scoped). The owner can never be disabled.
    if (patch.status !== undefined && patch.status !== m.status) {
      if (m.role === 'owner' && patch.status === 'deactivated') {
        throw new BadRequestException('The organization owner cannot be deactivated.');
      }
      m.status = patch.status;
      if (patch.status === 'deactivated') {
        m.deactivatedAt = new Date();
        m.deactivatedBy = actorUserId ?? null;
      } else {
        m.deactivatedAt = null;
        m.deactivatedBy = null;
      }
    }

    // Blank (or whitespace) clears the org title, which drops the member back to
    // whatever they set as their own job title in their profile.
    if (patch.title !== undefined) m.title = patch.title?.trim() || null;

    // Apply the department first so role↔department validation sees the new dept.
    if (patch.departmentId !== undefined) m.departmentId = patch.departmentId || null;

    if (patch.roleId !== undefined) {
      if (!patch.roleId) {
        // Clearing the custom role — attach the SYSTEM role for the tier so the
        // member still holds a real, visible role row (not a bare tier).
        const tier = patch.role ?? m.role;
        const resolved = await this.resolveRole(orgId, { role: tier });
        m.role = resolved.tier;
        m.roleId = resolved.roleId;
      } else {
        // Assigning a custom role: derive the enforced tier + validate that a
        // department-scoped role matches this member's department (mirrors add).
        const resolved = await this.resolveRole(orgId, {
          role: patch.role,
          roleId: patch.roleId,
          departmentId: m.departmentId ?? undefined,
        });
        m.roleId = resolved.roleId;
        m.role = resolved.tier;
        // A dept-scoped role also places the member in that department.
        if (patch.departmentId === undefined && resolved.departmentId) {
          m.departmentId = resolved.departmentId;
        }
      }
    } else if (patch.role !== undefined) {
      // Only the tier changed (e.g. the Directory's inline role switch) — keep
      // roleId pointing at that tier's system role.
      const resolved = await this.resolveRole(orgId, { role: patch.role });
      m.role = resolved.tier;
      m.roleId = resolved.roleId;
    }

    // Ownership is not a role you can hand out or take away from a member edit
    // (e.g. adding people to a role from the Roles page).
    if (prevTier === 'owner' && m.role !== 'owner') {
      throw new BadRequestException("The organization owner's role can't be changed.");
    }
    if (prevTier !== 'owner' && m.role === 'owner') {
      throw new BadRequestException('The owner role can’t be assigned to another member.');
    }

    await this.membershipRepo.save(m);

    // Probation is set/cleared on the member-onboarding record.
    if (patch.probationMonths !== undefined) {
      await this.setProbation(orgId, m, patch.probationMonths, actorUserId);
    }

    const user = m.userId
      ? await this.userRepo.findOne({ where: { id: m.userId } })
      : null;
    const view = this.toView(m, user || undefined);
    await this.attachOnboarding(orgId, membershipId, view);
    return view;
  }

  /**
   * Change a member's sign-in email. SECURITY-SENSITIVE: the OLD address is
   * always notified — directly via {@link MailService} (the transactional
   * mailer), NOT the preference-gated notifier — so the change reaches the
   * previous owner even if they have every in-app/email notification turned off.
   */
  async changeEmail(
    orgId: string,
    membershipId: string,
    newEmailRaw: string,
    actorUserId?: string,
  ): Promise<MemberView> {
    const m = await this.membershipRepo.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!m) throw new NotFoundException('Member not found');
    if (!m.userId) {
      throw new BadRequestException('This member has no user account yet (invite pending).');
    }
    const user = await this.userRepo.findOne({ where: { id: m.userId } });
    if (!user) throw new NotFoundException('User not found');

    const newEmail = newEmailRaw.trim().toLowerCase();
    const oldEmail = user.email;
    if (newEmail === oldEmail) return this.toView(m, user);

    // Uniqueness: no other user may already own this email.
    const clash = await this.userRepo.findOne({ where: { email: newEmail } });
    if (clash && clash.id !== user.id) {
      throw new ConflictException('That email is already in use by another account.');
    }

    user.email = newEmail;
    await this.userRepo.save(user);
    // Keep the membership's denormalised email aligned when it carries one.
    if (m.email) {
      m.email = newEmail;
      await this.membershipRepo.save(m);
    }

    // Notify the OLD address — unconditionally (bypasses notification prefs).
    if (oldEmail) {
      const org = await this.orgRepo.findOne({ where: { id: orgId } });
      const orgName = org?.name || 'your organization';
      const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const notice = emailChangedNoticeEmail({ name: user.firstName, orgName, oldEmail, newEmail, when });
      await this.mail.send({ to: oldEmail, subject: notice.subject, html: notice.html, text: notice.text });
    }
    void actorUserId; // reserved for future audit-log correlation

    return this.toView(m, user);
  }

  async removeMember(orgId: string, membershipId: string): Promise<void> {
    const m = await this.membershipRepo.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!m) throw new NotFoundException('Member not found');
    if (m.role === 'owner') {
      throw new ConflictException('The organization owner cannot be removed');
    }
    await this.membershipRepo.delete({ id: membershipId, organizationId: orgId });
  }

  private toView(m: OrgMembershipEntity, user?: UserEntity): MemberView {
    return {
      membershipId: m.id,
      userId: m.userId,
      email: m.email || user?.email || null,
      firstName: user?.firstName ?? null,
      lastName: user?.lastName ?? null,
      role: m.role,
      roleId: m.roleId,
      secondaryRoleId: m.secondaryRoleId ?? null,
      departmentId: m.departmentId ?? null,
      status: m.status,
      joinedAt: m.joinedAt,
      avatar: user?.avatar ?? null,
      phoneNumber: user?.phoneNumber ?? null,
      title: m.title ?? null,
      jobTitle: user?.jobTitle ?? null,
      location: user?.location ?? null,
      timezone: user?.timezone ?? null,
      dateOfBirth: user?.dateOfBirth ?? null,
      employeeCode: m.employeeCode ?? null,
      employmentType: m.employmentType ?? null,
      joiningDate: m.joiningDate ?? null,
    };
  }
}
