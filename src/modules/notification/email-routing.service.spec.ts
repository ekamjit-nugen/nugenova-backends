import { BadRequestException, NotFoundException } from '@nestjs/common';

import { EmailRoutingService, OrgEmailRouting, audiencesOf, roleAudience } from './email-routing.service';

/** Members shaped like Nugen IT Services, where the bug was reported. */
const member = (over: Record<string, unknown>) =>
  ({ status: 'active', personType: 'staff', roleId: null, secondaryRoleId: null, ...over }) as any;

const OWNER = member({ userId: 'u-owner', role: 'owner' });
// An admin who also holds a custom role called "ADMIN" — as in Nugen IT Services.
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
    it('is the role columns a member holds — owners and admins are not a column', () => {
      expect(audiencesOf(OWNER)).toEqual([]);
      expect(audiencesOf(ADMIN)).toEqual([roleAudience('r-admin-custom')]);
      expect(audiencesOf(PLAIN)).toEqual([]);
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

    it('always includes owners and admins, whatever their roles are set to', () => {
      const routing = new OrgEmailRouting({ 'attendance.daily_digest': { 'role:r-admin-custom': false } }, MEMBERS);
      expect(routing.teamRecipients('attendance.daily_digest').sort()).toEqual(['u-admin', 'u-owner']);
    });

    it('never sends a team email to members with no role, or to client portal users', () => {
      const recipients = new OrgEmailRouting({}, MEMBERS).teamRecipients('leave_requested');
      expect(recipients).not.toContain('u-plain');
      expect(recipients).not.toContain('u-client');
    });

    it('ignores choices stored for the old Owner / Admin / No custom role columns', () => {
      const routing = new OrgEmailRouting(
        { 'attendance.daily_digest': { 'tier:admin': false, norole: true } },
        MEMBERS,
      );
      expect(routing.teamRecipients('attendance.daily_digest').sort()).toEqual(['u-admin', 'u-owner']);
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

    it('still reaches an admin whose role is unticked', () => {
      const routing = new OrgEmailRouting({ 'attendance.absent': { 'role:r-admin-custom': false } }, MEMBERS);
      expect(routing.allowsUser('attendance.absent', 'u-admin')).toBe(true);
    });

    it('does not apply role choices to client portal users', () => {
      const client = member({ userId: 'u-c2', role: 'client', personType: 'client', roleId: 'r-sales' });
      const routing = new OrgEmailRouting({ 'client_ticket_reply': { 'role:r-sales': false } }, [client]);
      expect(routing.allowsUser('client_ticket_reply', 'u-c2')).toBe(true);
    });
  });

  describe('always-on and unknown emails', () => {
    it('sends a fixed email regardless of any stored choice', () => {
      const routing = new OrgEmailRouting({ otp: { 'role:r-sales': false } }, MEMBERS);
      expect(routing.allowsUser('otp', 'u-sakshi')).toBe(true);
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

  it('uses exactly the roles as columns, in the permission matrix order', async () => {
    const view = await service.matrix('org1');
    expect(view.audiences).toEqual([
      { key: 'role:r-hr', roleId: 'r-hr', label: 'HR' },
      { key: 'role:r-sales', roleId: 'r-sales', label: 'SALES' },
    ]);
    expect(roles.find).toHaveBeenCalledWith({ where: { organizationId: 'org1', isDeleted: false }, order: { createdAt: 'ASC' } });
  });

  it('shows the defaults in the matrix', async () => {
    const view = await service.matrix('org1');
    const digest = view.emails.find((e) => e.key === 'attendance.daily_digest')!;
    expect(digest.routing).toEqual({ 'role:r-hr': false, 'role:r-sales': false });
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
    await expect(service.set('org1', 'otp', 'role:r-hr', false)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unknown email, a made-up audience, the old Owner column, or another org’s role', async () => {
    await expect(service.set('org1', 'nope', 'role:r-hr', false)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.set('org1', 'attendance.daily_digest', 'tier:owner', false)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('org1', 'attendance.absent', 'everyone', false)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('org2', 'attendance.absent', 'role:r-hr', false)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renders a preview with the org name', async () => {
    const p = await service.preview('org1', 'attendance.daily_digest');
    expect(p.subject).toContain('16 Sept');
    expect(p.html).toContain('Nugen IT Services');
  });
});
