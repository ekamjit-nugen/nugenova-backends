import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';

import { OrganizationService } from './organization.service';
import { OrganizationEntity } from '../entities/organization.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { SessionEntity } from '../../auth/entities/session.entity';
import { TermsService } from '../../terms/terms.service';
import { MailService } from '../../../bootstrap/mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { PolicyService } from '../../policy/policy.service';
import { OrgRoleService } from './org-role.service';

/**
 * Pure unit specs — NO database. Every repository is a jest mock, so these run
 * under `npm test` (jest.config.js). Covers OrganizationService.createOrganization:
 * a new owner user is minted, an active owner membership is written, and the
 * owner is pointed at the org (setupStage complete, defaultOrganizationId set).
 */
describe('OrganizationService (unit, no DB)', () => {
  let service: OrganizationService;
  let orgRepo: any;
  let userRepo: any;
  let membershipRepo: any;
  let mailSend: jest.Mock;

  // Echo entities back through create()/save() so the service sees a persisted row.
  const passthrough = () => ({
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: v.id ?? 'generated-id', ...v })),
    findOne: jest.fn(),
    find: jest.fn(),
  });

  beforeEach(async () => {
    orgRepo = passthrough();
    userRepo = passthrough();
    membershipRepo = passthrough();
    mailSend = jest.fn().mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: getRepositoryToken(OrganizationEntity), useValue: orgRepo },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        {
          provide: getRepositoryToken(OrgMembershipEntity),
          useValue: membershipRepo,
        },
        {
          provide: getRepositoryToken(SessionEntity),
          useValue: { ...passthrough(), count: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: TermsService,
          useValue: {
            exists: jest.fn().mockResolvedValue(true),
            getVersion: jest.fn().mockReturnValue(1),
            needsConsent: jest.fn().mockReturnValue(true),
            get: jest.fn(),
          },
        },
        { provide: MailService, useValue: { send: mailSend } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('http://localhost:3111') },
        },
        {
          provide: PolicyService,
          useValue: { seedDefaultWorkTiming: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: OrgRoleService,
          useValue: {
            seedDefaults: jest.fn().mockResolvedValue([]),
            systemRoleForTier: jest.fn().mockResolvedValue({ id: 'owner-role-id' }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(OrganizationService);
  });

  describe('createOrganization', () => {
    it('creates the owner user, org, and active owner membership for a new email', async () => {
      // No existing owner, no existing membership, slug is free.
      userRepo.findOne.mockResolvedValue(null);
      orgRepo.findOne.mockResolvedValue(null); // slug is unique first try
      membershipRepo.findOne.mockResolvedValue(null);
      // save returns the entity with a stable id for org + user.
      userRepo.save.mockImplementation(async (u: any) => ({
        id: u.id ?? 'owner-1',
        ...u,
      }));
      orgRepo.save.mockImplementation(async (o: any) => ({
        id: 'org-1',
        ...o,
      }));

      const result = await service.createOrganization(
        {
          name: '  Acme Corp  ',
          ownerEmail: 'Owner@Example.com',
          ownerFirstName: 'Ada',
          termsId: 'terms-1',
        } as any,
        'super-admin-1',
      );

      // Owner user minted (lower-cased email).
      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'owner@example.com',
          firstName: 'Ada',
          isActive: true,
          setupStage: 'complete',
        }),
      );

      // Org created with trimmed name, active status + no consent yet (the
      // consent gate handles access), a slug, and createdBy.
      expect(orgRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Acme Corp',
          status: 'active',
          consent: null,
          createdBy: 'super-admin-1',
          slug: expect.any(String),
        }),
      );

      // Active owner membership written.
      expect(membershipRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          role: 'owner',
          status: 'active',
          invitedBy: 'super-admin-1',
        }),
      );

      // Owner pointed at the org on the denormalized list + default org.
      const savedOwner = userRepo.save.mock.calls.at(-1)[0];
      expect(savedOwner.organizations).toContain('org-1');
      expect(savedOwner.defaultOrganizationId).toBe('org-1');
      expect(savedOwner.setupStage).toBe('complete');
      expect(savedOwner.isActive).toBe(true);

      // Public shape returned — active, but consent not yet accepted.
      expect(result.organization).toEqual(
        expect.objectContaining({
          id: 'org-1',
          name: 'Acme Corp',
          status: 'active',
          consentAccepted: false,
          needsConsent: true,
        }),
      );
      expect(result.owner.email).toBe('owner@example.com');

      // The owner is emailed an invitation to sign in and set up the org.
      expect(mailSend).toHaveBeenCalledTimes(1);
      const mail = mailSend.mock.calls[0][0];
      expect(mail.to).toEqual({ email: 'owner@example.com', name: 'Ada' });
      expect(mail.subject).toMatch(/invited to set up Acme Corp/i);
      expect(mail.category).toBe('org-invite');
      expect(mail.html).toContain('/login');
    });

    it('reuses an existing user instead of minting a new one', async () => {
      const existingOwner = {
        id: 'owner-existing',
        email: 'owner@example.com',
        organizations: [],
        setupStage: 'complete',
        defaultOrganizationId: null,
        isActive: true,
      };
      userRepo.findOne.mockResolvedValue(existingOwner);
      orgRepo.findOne.mockResolvedValue(null);
      membershipRepo.findOne.mockResolvedValue(null);
      orgRepo.save.mockImplementation(async (o: any) => ({ id: 'org-2', ...o }));

      await service.createOrganization(
        { name: 'Beta', ownerEmail: 'owner@example.com', termsId: 'terms-1' } as any,
        'super-admin-1',
      );

      // The existing user is not re-created.
      expect(userRepo.create).not.toHaveBeenCalled();
      expect(membershipRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner-existing',
          organizationId: 'org-2',
          role: 'owner',
        }),
      );
    });

    it('refuses to duplicate an owner membership', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'owner-existing',
        email: 'owner@example.com',
        organizations: [],
      });
      orgRepo.findOne.mockResolvedValue(null);
      orgRepo.save.mockImplementation(async (o: any) => ({ id: 'org-3', ...o }));
      // Membership already exists → conflict.
      membershipRepo.findOne.mockResolvedValue({ id: 'm-1' });

      await expect(
        service.createOrganization(
          { name: 'Gamma', ownerEmail: 'owner@example.com', termsId: 'terms-1' } as any,
          'super-admin-1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('toPublic lifecycle derivation', () => {
    const termsSvc = () =>
      (service as any).terms as {
        getVersion: jest.Mock;
        needsConsent: jest.Mock;
      };

    const base = () =>
      ({
        id: 'o',
        name: 'O',
        slug: 'o',
        status: 'active',
        ownerId: 'u',
        createdAt: new Date(),
        termsId: 'terms-1',
        consent: null,
        onboardingStep: 0,
        onboardingCompleted: false,
      }) as any;

    it('suspended → lifecycle "suspended" regardless of consent/setup', () => {
      termsSvc().needsConsent.mockReturnValue(false);
      const pub = service.toPublic({
        ...base(),
        status: 'suspended',
        onboardingCompleted: true,
      });
      expect(pub.lifecycle).toBe('suspended');
    });

    it('never consented → "awaiting_consent"', () => {
      termsSvc().needsConsent.mockReturnValue(true);
      const pub = service.toPublic(base());
      expect(pub.lifecycle).toBe('awaiting_consent');
    });

    it('accepted before but terms bumped → "reconsent"', () => {
      termsSvc().needsConsent.mockReturnValue(true);
      const pub = service.toPublic({
        ...base(),
        consent: { version: 1 } as any,
      });
      expect(pub.lifecycle).toBe('reconsent');
    });

    it('consented but wizard unfinished → "setting_up" (with step)', () => {
      termsSvc().needsConsent.mockReturnValue(false);
      const pub = service.toPublic({
        ...base(),
        consent: { version: 2 } as any,
        onboardingStep: 2,
        onboardingCompleted: false,
      });
      expect(pub.lifecycle).toBe('setting_up');
      expect(pub.onboardingStep).toBe(2);
    });

    it('consented and setup finished → "active"', () => {
      termsSvc().needsConsent.mockReturnValue(false);
      const pub = service.toPublic({
        ...base(),
        consent: { version: 2 } as any,
        onboardingCompleted: true,
      });
      expect(pub.lifecycle).toBe('active');
      expect(pub.onboardingCompleted).toBe(true);
    });
  });
});
