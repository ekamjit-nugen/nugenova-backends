import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { NotifierService } from './notifier.service';
import { NotificationService } from './notification.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { MailService } from '../../bootstrap/mail/mail.service';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { UserEntity } from '../auth/entities/user.entity';

/**
 * Unit specs for the notify() dual-channel fan-out: an email-worthy type sends a
 * branded email alongside the in-app row, an in-app-only type doesn't, and each
 * channel's preference gate is honoured independently.
 */
describe('NotifierService (email fan-out)', () => {
  let service: NotifierService;
  let create: jest.Mock;
  let send: jest.Mock;
  let allows: jest.Mock;
  let allowsEmail: jest.Mock;
  let userFindOne: jest.Mock;

  const build = async () => {
    create = jest.fn().mockResolvedValue(undefined);
    send = jest.fn().mockResolvedValue(true);
    allows = jest.fn().mockResolvedValue(true);
    allowsEmail = jest.fn().mockResolvedValue(true);
    userFindOne = jest.fn().mockResolvedValue({ id: 'u1', email: 'nora@acme.test', firstName: 'Nora', lastName: 'P' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotifierService,
        { provide: NotificationService, useValue: { create } },
        { provide: NotificationPreferenceService, useValue: { allows, allowsEmail } },
        { provide: MailService, useValue: { send } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('https://app.nugenova.com') } },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: {} },
        { provide: getRepositoryToken(RoleEntity), useValue: {} },
        { provide: getRepositoryToken(UserEntity), useValue: { findOne: userFindOne } },
      ],
    }).compile();
    service = moduleRef.get(NotifierService);
  };

  beforeEach(build);

  const base = {
    organizationId: 'org1',
    userId: 'u1',
    actorId: 'mgr1',
    title: 'Leave approved',
    body: 'Your Casual Leave was approved.',
    data: { actionUrl: '/leaves' },
  };

  it('sends a branded email for an email-worthy type, with an absolute CTA', async () => {
    await service.notify({ ...base, type: 'leave_approved' });
    expect(create).toHaveBeenCalledTimes(1); // in-app
    expect(send).toHaveBeenCalledTimes(1); // email
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual({ email: 'nora@acme.test', name: 'Nora P' });
    expect(mail.category).toBe('notification');
    expect(mail.subject).toBe('Leave approved');
    expect(mail.html).toContain('https://app.nugenova.com/leaves'); // absolute CTA link
  });

  it('does NOT email an in-app-only type (not in the registry)', async () => {
    await service.notify({ ...base, type: 'clock_in' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('honours email:false — in-app only even for an email-worthy type', async () => {
    await service.notify({ ...base, type: 'leave_approved', email: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('suppresses the email when the email preference gate says no (in-app still sent)', async () => {
    allowsEmail.mockResolvedValue(false);
    await service.notify({ ...base, type: 'leave_approved' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('suppresses the in-app row when its preference gate says no (email still sent)', async () => {
    allows.mockResolvedValue(false);
    await service.notify({ ...base, type: 'leave_approved' });
    expect(create).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1); // channels are independent
  });

  it('never notifies a user about their own action', async () => {
    await service.notify({ ...base, type: 'leave_approved', actorId: 'u1' });
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('an email override can force an email for an otherwise in-app-only type', async () => {
    await service.notify({ ...base, type: 'clock_in', email: { eyebrow: 'Attendance', subject: 'Clocked in' } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe('Clocked in');
  });
});
