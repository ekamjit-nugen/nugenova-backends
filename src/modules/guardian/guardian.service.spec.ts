import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GuardianService } from './guardian.service';
import { GuardianLinkEntity } from './entities/guardian-link.entity';
import { ConsentLedgerEntity } from './entities/consent-ledger.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';

/**
 * Pure unit specs — NO database. Pin the guardian/consent invariants:
 *  - a link's two sides must be a guardian and a student (personType, both ways);
 *  - consent is append-only and idempotent; a guardian may only consent for a
 *    LINKED student; revoke soft-stamps the active record;
 *  - isConsented reflects only un-revoked records.
 */
describe('GuardianService (unit, no DB)', () => {
  let service: GuardianService;
  let links: any;
  let consents: any;
  let memberships: any;
  let tx: any;

  const ORG = 'org1';

  beforeEach(async () => {
    tx = {
      update: jest.fn(),
      save: jest.fn(async (_e: any, v: any) => ({ id: v.id ?? 'link1', ...v })),
      create: jest.fn((_e: any, v: any) => ({ ...v })),
    };
    const manager = { transaction: jest.fn(async (cb: any) => cb(tx)) };

    links = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (v) => v),
      create: jest.fn((v) => ({ ...v })),
      manager,
    };
    consents = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (v) => (Array.isArray(v) ? v : { id: v.id ?? 'con1', ...v })),
      create: jest.fn((v) => ({ ...v })),
    };
    memberships = { findOne: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GuardianService,
        { provide: getRepositoryToken(GuardianLinkEntity), useValue: links },
        { provide: getRepositoryToken(ConsentLedgerEntity), useValue: consents },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: memberships },
      ],
    }).compile();
    service = moduleRef.get(GuardianService);
  });

  describe('linkGuardian — personType both ways', () => {
    it('rejects a guardian side that is not a guardian membership', async () => {
      memberships.findOne.mockResolvedValueOnce({ id: 'g', organizationId: ORG, personType: 'student' });
      await expect(
        service.linkGuardian(ORG, { guardianMembershipId: 'g', studentMembershipId: 's' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a student side that is not a student membership', async () => {
      memberships.findOne
        .mockResolvedValueOnce({ id: 'g', organizationId: ORG, personType: 'guardian' })
        .mockResolvedValueOnce({ id: 's', organizationId: ORG, personType: 'staff' });
      await expect(
        service.linkGuardian(ORG, { guardianMembershipId: 'g', studentMembershipId: 's' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('links a guardian to a student', async () => {
      memberships.findOne
        .mockResolvedValueOnce({ id: 'g', organizationId: ORG, personType: 'guardian' })
        .mockResolvedValueOnce({ id: 's', organizationId: ORG, personType: 'student' });
      links.findOne.mockResolvedValue(null); // no existing pair
      const link = await service.linkGuardian(
        ORG,
        { guardianMembershipId: 'g', studentMembershipId: 's', relationship: 'mother', isPrimary: true },
        'admin',
      );
      expect(link.guardianMembershipId).toBe('g');
      expect(link.studentMembershipId).toBe('s');
      expect(link.isPrimary).toBe(true);
      // Promoting to primary cleared other primaries first.
      expect(tx.update).toHaveBeenCalled();
    });

    it('rejects re-linking an already-active pair', async () => {
      memberships.findOne
        .mockResolvedValueOnce({ id: 'g', organizationId: ORG, personType: 'guardian' })
        .mockResolvedValueOnce({ id: 's', organizationId: ORG, personType: 'student' });
      links.findOne.mockResolvedValue({ id: 'l1', deactivatedAt: null });
      await expect(
        service.linkGuardian(ORG, { guardianMembershipId: 'g', studentMembershipId: 's' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('recordConsent', () => {
    it('records self-consent when the grantor is the subject', async () => {
      memberships.findOne.mockResolvedValue({ id: 's', organizationId: ORG, personType: 'student' });
      consents.findOne.mockResolvedValue(null); // no active consent
      const c = await service.recordConsent(
        ORG,
        { subjectMembershipId: 's', purpose: 'data_processing', grantedByMembershipId: 's' },
        'admin',
      );
      expect(c.basis).toBe('self');
      expect(c.active).toBe(true);
      expect(c.purpose).toBe('data_processing');
    });

    it('rejects a guardian consenting for a student they are NOT linked to', async () => {
      memberships.findOne.mockResolvedValue({ id: 's', organizationId: ORG, personType: 'student' });
      links.findOne.mockResolvedValue(null); // no link
      await expect(
        service.recordConsent(
          ORG,
          { subjectMembershipId: 's', purpose: 'ai_tier_2', grantedByMembershipId: 'g' },
          'admin',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records guardian-consent when a link exists', async () => {
      memberships.findOne.mockResolvedValue({ id: 's', organizationId: ORG, personType: 'student' });
      consents.findOne.mockResolvedValue(null); // no active consent yet
      links.findOne.mockResolvedValue({ id: 'l1', deactivatedAt: null }); // linked
      const c = await service.recordConsent(
        ORG,
        { subjectMembershipId: 's', purpose: 'ai_tier_2', grantedByMembershipId: 'g' },
        'admin',
      );
      expect(c.basis).toBe('guardian');
      expect(c.grantedByMembershipId).toBe('g');
    });

    it('is idempotent — an already-active consent is returned, not duplicated', async () => {
      memberships.findOne.mockResolvedValue({ id: 's', organizationId: ORG, personType: 'student' });
      consents.findOne.mockResolvedValue({
        id: 'existing', subjectMembershipId: 's', purpose: 'data_processing',
        basis: 'self', grantedByMembershipId: 's', grantedAt: new Date(), revokedAt: null, version: 1,
      });
      const c = await service.recordConsent(
        ORG,
        { subjectMembershipId: 's', purpose: 'data_processing', grantedByMembershipId: 's' },
        'admin',
      );
      expect(c.id).toBe('existing');
      expect(consents.save).not.toHaveBeenCalled();
    });
  });

  describe('revokeConsent / isConsented', () => {
    it('soft-stamps every active record and reports the count', async () => {
      memberships.findOne.mockResolvedValue({ id: 's', organizationId: ORG, personType: 'student' });
      const active = [{ id: 'c1', revokedAt: null }, { id: 'c2', revokedAt: null }];
      consents.find.mockResolvedValue(active);
      const res = await service.revokeConsent(
        ORG,
        { subjectMembershipId: 's', purpose: 'ai_tier_2' },
        'admin',
      );
      expect(res.revoked).toBe(2);
      expect(active[0].revokedAt).not.toBeNull();
      expect(consents.save).toHaveBeenCalledWith(active);
    });

    it('revoke is a no-op when nothing is active', async () => {
      memberships.findOne.mockResolvedValue({ id: 's', organizationId: ORG, personType: 'student' });
      consents.find.mockResolvedValue([]);
      const res = await service.revokeConsent(ORG, { subjectMembershipId: 's', purpose: 'x' }, 'admin');
      expect(res.revoked).toBe(0);
    });

    it('isConsented is true only when an un-revoked record exists', async () => {
      consents.findOne.mockResolvedValueOnce({ id: 'c1', revokedAt: null });
      expect(await service.isConsented(ORG, 's', 'ai_tier_2')).toBe(true);
      consents.findOne.mockResolvedValueOnce(null);
      expect(await service.isConsented(ORG, 's', 'ai_tier_2')).toBe(false);
    });
  });

  describe('unlinkGuardian', () => {
    it('404s on a missing link', async () => {
      links.findOne.mockResolvedValue(null);
      await expect(service.unlinkGuardian(ORG, 'nope', 'admin')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('soft-unlinks (stamps deactivatedAt, clears primary)', async () => {
      links.findOne.mockResolvedValue({ id: 'l1', organizationId: ORG, deactivatedAt: null, isPrimary: true });
      const v = await service.unlinkGuardian(ORG, 'l1', 'admin');
      expect(v.isPrimary).toBe(false);
      expect(links.save).toHaveBeenCalledWith(expect.objectContaining({ deactivatedAt: expect.any(Date) }));
    });
  });
});
