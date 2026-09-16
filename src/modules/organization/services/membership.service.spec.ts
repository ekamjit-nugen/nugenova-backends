import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { MembershipService } from './membership.service';
import { OrgLimitsService } from './org-limits.service';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { RoleEntity } from '../../auth/entities/role.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { MailService } from '../../../bootstrap/mail/mail.service';
import { MemberOnboardingEntity } from '../../onboarding/entities/member-onboarding.entity';

/**
 * Pure unit specs — NO database. Focus on addMember's role resolution: enforced
 * tier vs. custom role (tier derived), the department↔role relation, and the
 * owner-cannot-be-removed guard.
 */
describe('MembershipService (unit, no DB)', () => {
  let service: MembershipService;
  let membershipRepo: any;
  let userRepo: any;
  let roleRepo: any;
  let orgRepo: any;
  let limits: any;
  let mail: any;

  const passthrough = () => ({
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: v.id ?? 'gen', ...v })),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  });

  beforeEach(async () => {
    membershipRepo = passthrough();
    userRepo = passthrough();
    roleRepo = passthrough();
    orgRepo = passthrough();
    limits = { assertSeatAvailable: jest.fn().mockResolvedValue(undefined) };
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MembershipService,
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: membershipRepo },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: getRepositoryToken(RoleEntity), useValue: roleRepo },
        { provide: getRepositoryToken(OrganizationEntity), useValue: orgRepo },
        { provide: getRepositoryToken(MemberOnboardingEntity), useValue: passthrough() },
        { provide: OrgLimitsService, useValue: limits },
        { provide: MailService, useValue: mail },
      ],
    }).compile();
    service = moduleRef.get(MembershipService);
  });

  const freshUser = () => {
    userRepo.findOne.mockResolvedValue(null); // new user
    userRepo.save.mockImplementation(async (u: any) => ({ id: 'user-1', ...u }));
    membershipRepo.findOne.mockResolvedValue(null); // no existing membership
  };

  it('attaches the tier system role when no custom role is picked', async () => {
    freshUser();
    // The org's Manager system role backs the 'manager' tier.
    roleRepo.findOne.mockResolvedValue({ id: 'sys-manager', tier: 'manager', isSystem: true });
    await service.addMember('org-1', { email: 'a@b.com', role: 'manager' } as any, 'inviter');
    expect(membershipRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'manager', roleId: 'sys-manager' }),
    );
  });

  it('derives the enforced tier from a custom role when none is passed', async () => {
    freshUser();
    roleRepo.findOne.mockResolvedValue({ id: 'hr-role', name: 'hr', departmentId: null, isDeleted: false });
    await service.addMember('org-1', { email: 'a@b.com', roleId: 'hr-role' } as any, 'inviter');
    // hr → manager tier (ROLE_NAME_TO_TIER), roleId preserved
    expect(membershipRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'manager', roleId: 'hr-role' }),
    );
  });

  it('rejects a department-scoped role assigned outside its department', async () => {
    freshUser();
    roleRepo.findOne.mockResolvedValue({ id: 'r', name: 'lead', departmentId: 'dept-eng', isDeleted: false });
    await expect(
      service.addMember('org-1', { email: 'a@b.com', roleId: 'r', departmentId: 'dept-sales' } as any, 'inviter'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the custom role does not exist in the org', async () => {
    freshUser();
    roleRepo.findOne.mockResolvedValue(null);
    await expect(
      service.addMember('org-1', { email: 'a@b.com', roleId: 'ghost' } as any, 'inviter'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects adding the same person twice', async () => {
    userRepo.findOne.mockResolvedValue({ id: 'user-1', email: 'a@b.com', organizations: [] });
    membershipRepo.findOne.mockResolvedValue({ id: 'm-exists' });
    await expect(
      service.addMember('org-1', { email: 'a@b.com', role: 'employee' } as any, 'inviter'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updateMember: assigning a custom role derives the enforced tier', async () => {
    membershipRepo.findOne.mockResolvedValue({
      id: 'm1', organizationId: 'org-1', role: 'employee', roleId: null, departmentId: null,
    });
    roleRepo.findOne.mockResolvedValue({ id: 'hr-role', name: 'hr', departmentId: null, isDeleted: false });
    await service.updateMember('org-1', 'm1', { roleId: 'hr-role' });
    // hr → manager tier; roleId set.
    expect(membershipRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'manager', roleId: 'hr-role' }),
    );
  });

  it('updateMember: a dept-scoped role also places the member in that department', async () => {
    membershipRepo.findOne.mockResolvedValue({
      id: 'm1', organizationId: 'org-1', role: 'employee', roleId: null, departmentId: null,
    });
    roleRepo.findOne.mockResolvedValue({ id: 'r', name: 'lead', departmentId: 'dept-eng', isDeleted: false });
    await service.updateMember('org-1', 'm1', { roleId: 'r' });
    expect(membershipRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: 'r', departmentId: 'dept-eng' }),
    );
  });

  it('updateMember: rejects a dept-scoped role that conflicts with the chosen department', async () => {
    membershipRepo.findOne.mockResolvedValue({
      id: 'm1', organizationId: 'org-1', role: 'employee', roleId: null, departmentId: null,
    });
    roleRepo.findOne.mockResolvedValue({ id: 'r', name: 'lead', departmentId: 'dept-eng', isDeleted: false });
    await expect(
      service.updateMember('org-1', 'm1', { roleId: 'r', departmentId: 'dept-sales' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateMember: refuses to assign the owner role to another member', async () => {
    membershipRepo.findOne.mockResolvedValue({ id: 'm1', organizationId: 'org-1', role: 'employee', roleId: 'emp', departmentId: null });
    roleRepo.findOne.mockResolvedValue({ id: 'owner-role', name: 'owner', tier: 'owner', isSystem: true, departmentId: null, isDeleted: false });
    await expect(service.updateMember('org-1', 'm1', { roleId: 'owner-role' })).rejects.toThrow(/owner role can’t be assigned/);
    expect(membershipRepo.save).not.toHaveBeenCalled();
  });

  it("updateMember: refuses to move the owner into another role", async () => {
    membershipRepo.findOne.mockResolvedValue({ id: 'm-owner', organizationId: 'org-1', role: 'owner', roleId: 'owner-role', departmentId: null });
    roleRepo.findOne.mockResolvedValue({ id: 'hr-role', name: 'hr', departmentId: null, isDeleted: false });
    await expect(service.updateMember('org-1', 'm-owner', { roleId: 'hr-role' })).rejects.toThrow(/owner's role can't be changed/);
    expect(membershipRepo.save).not.toHaveBeenCalled();
  });

  it('refuses to remove the organization owner', async () => {
    membershipRepo.findOne.mockResolvedValue({ id: 'm-owner', role: 'owner', organizationId: 'org-1' });
    await expect(service.removeMember('org-1', 'm-owner')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
