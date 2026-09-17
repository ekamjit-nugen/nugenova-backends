import { BadRequestException, NotFoundException } from '@nestjs/common';

import {
  AUDIENCE_ADMIN,
  AUDIENCE_NO_ROLE,
  AUDIENCE_OWNER,
  EmailRoutingService,
  OrgEmailRouting,
  audiencesOf,
  roleAudience,
} from './email-routing.service';

/** Members shaped like Nugen IT Services, where the bug was reported. */
const member = (over: Record<string, unknown>) =>
  ({ status: 'active', personType: 'staff', roleId: null, secondaryRoleId: null, ...over }) as any;

const OWNER = member({ userId: 'u-owner', role: 'owner' });
const ADMIN = member({ userId: 'u-admin', role: 'admin', roleId: 'r-admin-custom' });
const HR = member({ userId: 'u-hr', role: 'manager', roleId: 'r-hr' });
// Sakshi: an employee whose SALES role grants attendance:view — which used to put
// her on the org-wide attendance summary.
const SALES = member({ userId: 'u-sakshi', role: 'employee', roleId: 'r-sales' });
const PLAIN = member({ userId: 'u-plain', role: 'employee' });
const CLIENT = member({ userId: 'u-client', role: 'client', personType: 'client' });
const MEMBERS = [OWNER, ADMIN, HR, SALES, PLAIN, CLIENT];

describe('email routing', () => {
  describe('audiencesOf', () => {
    it('puts an owner/admin in their tier column, plus any custom role they hold', () => {
      expect(audiencesOf(OWNER)).toEqual([AUDIENCE_OWNER]);
      expect(audiencesOf(ADMIN)).toEqual([AUDIENCE_ADMIN, roleAudience('r-admin-custom')]);
    });
    it('puts a member with no custom role in the "No custom role" column', () => {
      expect(audiencesOf(PLAIN)).toEqual([AUDIENCE_NO_ROLE]);
    });
    it('counts a secondary role too', () => {
      expect(audiencesOf(member({ role: 'employee', roleId: 'a', secondaryRoleId: 'b' }))).toEqual(['role:a', 'role:b']);
    });
  });

  describe('team emails (the daily attendance summary)', () => {
    it('by default goes to owners and admins only — not to Sakshi', () => {
      const routing = new OrgEmailRouting({}, MEMBERS);
      expect(routing.teamRecipients('attendance.daily_digest').sort()).toEqual(['u-admin', 'u-owner']);
      expect(routing.allowsUser('attendance.daily_digest', 'u-sakshi')).toBe(false);
    });

    it('adds a role once it is ticked', () => {
      const routing = new OrgEmailRouting({ 'attendance.daily_digest': { 'role:r-hr': true } }, MEMBERS);
      expect(routing.teamRecipients('attendance.daily_digest').sort()).toEqual(['u-admin', 'u-hr', 'u-owner']);
    });

    it('drops admins when Admin is unticked — unless another ticked column covers them', () => {
      const off = new OrgEmailRouting({ 'attendance.daily_digest': { [AUDIENCE_ADMIN]: false } }, MEMBERS);
      expect(off.teamRecipients('attendance.daily_digest')).toEqual(['u-owner']);

      const viaRole = new OrgEmailRouting(
        { 'attendance.daily_digest': { [AUDIENCE_ADMIN]: false, 'role:r-admin-custom': true } },
        MEMBERS,
      );
      expect(viaRole.teamRecipients('attendance.daily_digest').sort()).toEqual(['u-admin', 'u-owner']);
    });

    it('never sends a team email to client portal users', () => {
      const routing = new OrgEmailRouting({ 'leave_requested': { [AUDIENCE_NO_ROLE]: true } }, MEMBERS);
      expect(routing.teamRecipients('leave_requested')).not.toContain('u-client');
    });
  });

  describe('personal emails (you were marked absent)', () => {
    it('by default everyone gets their own', () => {
      const routing = new OrgEmailRouting({}, MEMBERS);
      for (const m of MEMBERS) expect(routing.allowsUser('attendance.absent', m.userId)).toBe(true);
    });

    it("stops only the unticked role's members", () => {
      const routing = new OrgEmailRouting({ 'attendance.absent': { 'role:r-sales': false } }, MEMBERS);
      expect(routing.allowsUser('attendance.absent', 'u-sakshi')).toBe(false);
      expect(routing.allowsUser('attendance.absent', 'u-plain')).toBe(true);
      expect(routing.allowsUser('attendance.absent', 'u-hr')).toBe(true);
    });

    it('does not apply role choices to client portal users', () => {
      const routing = new OrgEmailRouting({ 'client_ticket_reply': { [AUDIENCE_NO_ROLE]: false } }, MEMBERS);
      expect(routing.allowsUser('client_ticket_reply', 'u-client')).toBe(true);
    });
  });

  describe('always-on and unknown emails', () => {
    it('sends a fixed email regardless of any stored choice', () => {
      const routing = new OrgEmailRouting({ otp: { [AUDIENCE_NO_ROLE]: false } }, MEMBERS);
      expect(routing.allowsUser('otp', 'u-plain')).toBe(true);
    });

    it('lets an email the catalog does not know about through — routing never silently drops mail', () => {
      const routing = new OrgEmailRouting({}, MEMBERS);
      expect(routing.allowsUser('something_new', 'u-sakshi')).toBe(true);
    });

    it('lets someone with no membership in the org through', () => {
      expect(new OrgEmailRouting({}, MEMBERS).allowsUser('attendance.absent', 'u-elsewhere')).toBe(true);
    });
  });
});

describe('EmailRoutingService', () => {
  let service: EmailRoutingService;
  let settings: any;
  let roles: any;
  let saved: any;

  beforeEach(() => {
    saved = null;
    settings = {
      findOne: jest.fn().mockImplementation(async () => saved),
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => (saved = v)),
    };
    roles = {
      find: jest.fn().mockResolvedValue([
        { id: 'r-hr', name: 'hr', displayName: 'HR' },
        { id: 'r-sales', name: 'sales', displayName: 'SALES' },
      ]),
      findOne: jest.fn(async ({ where }) => (['r-hr', 'r-sales'].includes(where.id) && where.organizationId === 'org1' ? { id: where.id } : null)),
    };
    service = new EmailRoutingService(
      settings,
      { find: jest.fn().mockResolvedValue(MEMBERS) } as any,
      roles,
      { findOne: jest.fn().mockResolvedValue({ name: 'Nugen IT Services' }) } as any,
      { get: jest.fn().mockReturnValue('https://nugenova.com') } as any,
    );
  });

  it('lists Owner, Admin, every role and No custom role as columns', async () => {
    const view = await service.matrix('org1');
    expect(view.audiences.map((a) => a.label)).toEqual(['Owner', 'Admin', 'HR', 'SALES', 'No custom role']);
  });

  it('shows the defaults in the matrix', async () => {
    const view = await service.matrix('org1');
    const digest = view.emails.find((e) => e.key === 'attendance.daily_digest')!;
    expect(digest.routing).toEqual({
      [AUDIENCE_OWNER]: true, [AUDIENCE_ADMIN]: true, 'role:r-hr': false, 'role:r-sales': false, [AUDIENCE_NO_ROLE]: false,
    });
  });

  it('stores a tick and reflects it', async () => {
    const view = await service.set('org1', 'attendance.daily_digest', 'role:r-hr', true);
    expect(saved.emailRouting).toEqual({ 'attendance.daily_digest': { 'role:r-hr': true } });
    expect(view.emails.find((e) => e.key === 'attendance.daily_digest')!.routing['role:r-hr']).toBe(true);
  });

  it('forgets a choice that is set back to the default', async () => {
    await service.set('org1', 'attendance.daily_digest', 'role:r-hr', true);
    await service.set('org1', 'attendance.daily_digest', 'role:r-hr', false);
    expect(saved.emailRouting).toEqual({});
  });

  it('refuses to change an always-sent email', async () => {
    await expect(service.set('org1', 'otp', AUDIENCE_NO_ROLE, false)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unknown email, a made-up audience, or another org’s role', async () => {
    await expect(service.set('org1', 'nope', AUDIENCE_OWNER, false)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.set('org1', 'attendance.absent', 'everyone', false)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('org2', 'attendance.absent', 'role:r-hr', false)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renders a preview with the org name', async () => {
    const p = await service.preview('org1', 'attendance.daily_digest');
    expect(p.subject).toContain('16 Sept');
    expect(p.html).toContain('Nugen IT Services');
  });
});
