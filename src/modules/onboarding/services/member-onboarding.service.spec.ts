import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';

import { OnboardingLifecycleService } from './member-onboarding.service';
import { MemberOnboardingEntity } from '../entities/member-onboarding.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { PolicyService } from '../../policy/policy.service';
import { MailService } from '../../../bootstrap/mail/mail.service';
import { NotifierService } from '../../notification/notifier.service';
import { OnboardingConfig } from '../../policy/onboarding-catalog';

/**
 * Pure unit specs — NO database. Repos + PolicyService + MailService are mocks.
 * Covers the deterministic decision logic: probation/target date math, the
 * reconcile-on-read rules, the progress roll-up, and the self-complete guard.
 */
describe('OnboardingLifecycleService (unit, no DB)', () => {
  let service: OnboardingLifecycleService;
  let repo: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock; create: jest.Mock };

  const cfg: OnboardingConfig = {
    documents: [
      { key: 'photo_id', title: 'Government Photo ID', required: true },
      { key: 'pan_card', title: 'PAN Card', required: true },
    ],
    checklist: [
      { key: 'welcome_read', title: 'Read the welcome guide', category: 'welcome', assignedTo: 'self' },
      { key: 'it_accounts', title: 'Provision IT accounts', category: 'it_setup', assignedTo: 'it' },
    ],
    defaultProbationMonths: 6,
    targetDays: 14,
    profileFields: ['jobTitle', 'phoneNumber'],
  };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (r) => r),
      create: jest.fn().mockImplementation((r) => r),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OnboardingLifecycleService,
        { provide: getRepositoryToken(MemberOnboardingEntity), useValue: repo },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: {} },
        { provide: getRepositoryToken(OrganizationEntity), useValue: { findOne: jest.fn() } },
        {
          provide: PolicyService,
          useValue: {
            getOnboardingConfig: jest.fn().mockResolvedValue(cfg),
            pendingAcknowledgements: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: MailService, useValue: { send: jest.fn().mockResolvedValue(true) } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NotifierService, useValue: { notify: jest.fn(), notifyManagers: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(OnboardingLifecycleService);
  });

  describe('date math', () => {
    it('adds probation months', () => {
      const d = (service as any).addMonths(new Date('2026-01-15T00:00:00Z'), 6) as Date;
      expect(d.getUTCMonth()).toBe(6); // July (0-indexed)
    });
    it('adds target days', () => {
      const d = (service as any).addDays(new Date('2026-01-01T00:00:00Z'), 14) as Date;
      expect(d.getUTCDate()).toBe(15);
    });
  });

  describe('seed', () => {
    it('seeds every config document as pending', () => {
      const docs = (service as any).seedDocuments(cfg);
      expect(docs).toHaveLength(2);
      expect(docs.every((d: any) => d.status === 'pending')).toBe(true);
    });
    it('seeds the checklist preserving assignment', () => {
      const list = (service as any).seedChecklist(cfg);
      expect(list.find((c: any) => c.key === 'it_accounts').assignedTo).toBe('it');
    });
  });

  describe('progress', () => {
    it('rolls up verified docs + done tasks into a percent', () => {
      const record = {
        documents: [
          { key: 'a', required: true, status: 'verified' },
          { key: 'b', required: true, status: 'uploaded' },
        ],
        checklist: [
          { key: 'x', status: 'done' },
          { key: 'y', status: 'pending' },
        ],
      } as any;
      const p = (service as any).progress(record);
      expect(p.documentsTotal).toBe(2);
      expect(p.documentsUploaded).toBe(2);
      expect(p.documentsVerified).toBe(1);
      expect(p.checklistDone).toBe(1);
      // (1 verified + 1 done) / (2 docs + 2 tasks) = 50%
      expect(p.percent).toBe(50);
    });
    it('is 100% when there is nothing to do', () => {
      const p = (service as any).progress({ documents: [], checklist: [] });
      expect(p.percent).toBe(100);
    });
  });

  describe('reconcile-on-read', () => {
    it('adds a newly-required policy document as pending', async () => {
      const record = {
        status: 'in_progress',
        documents: [{ key: 'photo_id', title: 'Government Photo ID', required: true, status: 'pending' }],
      } as any;
      await (service as any).reconcile(record, cfg);
      const keys = record.documents.map((d: any) => d.key);
      expect(keys).toContain('pan_card');
      expect(record.documents.find((d: any) => d.key === 'pan_card').status).toBe('pending');
      expect(repo.save).toHaveBeenCalled();
    });

    it('drops a policy-removed document only when still pending', async () => {
      const record = {
        status: 'in_progress',
        documents: [
          { key: 'photo_id', title: 'Government Photo ID', required: true, status: 'pending' },
          { key: 'pan_card', title: 'PAN Card', required: true, status: 'pending' },
          { key: 'old_doc', title: 'Old', required: true, status: 'pending' },
        ],
      } as any;
      await (service as any).reconcile(record, cfg);
      expect(record.documents.map((d: any) => d.key)).not.toContain('old_doc');
    });

    it('keeps a policy-removed document that was already uploaded', async () => {
      const record = {
        status: 'in_progress',
        documents: [
          { key: 'photo_id', title: 'Government Photo ID', required: true, status: 'pending' },
          { key: 'pan_card', title: 'PAN Card', required: true, status: 'pending' },
          { key: 'old_doc', title: 'Old', required: true, status: 'uploaded', fileId: 'f1' },
        ],
      } as any;
      await (service as any).reconcile(record, cfg);
      expect(record.documents.map((d: any) => d.key)).toContain('old_doc');
    });

    it('skips completed records (historical)', async () => {
      const record = { status: 'completed', documents: [] } as any;
      await (service as any).reconcile(record, cfg);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('auto-completes policies_ack when nothing is left to acknowledge', async () => {
      const policy = service['policy'] as any;
      policy.pendingAcknowledgements.mockResolvedValue([]); // nothing outstanding
      const record = {
        status: 'in_progress',
        organizationId: 'org1',
        userId: 'u1',
        documents: [],
        checklist: [{ key: 'policies_ack', category: 'compliance', assignedTo: 'self', status: 'pending' }],
      } as any;
      await (service as any).reconcile(record, cfg);
      expect(record.checklist[0].status).toBe('done');
      expect(repo.save).toHaveBeenCalled();
    });

    it('leaves policies_ack pending while acknowledgements are outstanding', async () => {
      const policy = service['policy'] as any;
      policy.pendingAcknowledgements.mockResolvedValue([{ id: 'p1' }]); // still owes one
      const record = {
        status: 'in_progress',
        organizationId: 'org1',
        userId: 'u1',
        documents: [],
        checklist: [{ key: 'policies_ack', category: 'compliance', assignedTo: 'self', status: 'pending' }],
      } as any;
      await (service as any).reconcile(record, cfg);
      expect(record.checklist[0].status).toBe('pending');
    });
  });

  describe('self-complete guard', () => {
    it('blocks a hire from completing an IT-owned task', async () => {
      jest.spyOn(service as any, 'myRecord').mockResolvedValue({
        status: 'in_progress',
        checklist: [{ key: 'it_accounts', category: 'it_setup', assignedTo: 'it', status: 'pending' }],
      });
      await expect(
        service.completeMyChecklistItem('org1', 'u1', 'it_accounts'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a hire complete a self-serviceable welcome task', async () => {
      const record: any = {
        status: 'in_progress',
        documents: [],
        checklist: [{ key: 'welcome_read', category: 'welcome', assignedTo: 'self', status: 'pending' }],
      };
      jest.spyOn(service as any, 'myRecord').mockResolvedValue(record);
      await service.completeMyChecklistItem('org1', 'u1', 'welcome_read');
      expect(record.checklist[0].status).toBe('done');
    });
  });
});
