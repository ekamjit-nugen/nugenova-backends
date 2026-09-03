import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { OrgNotificationSettingService } from './org-notification-setting.service';
import { OrgNotificationSettingEntity } from './entities/org-notification-setting.entity';

/**
 * allowsForEmployee resolution: a per-EVENT override wins over the per-category
 * default, which wins over the built-in "on". So an owner can silence one event
 * while keeping the rest of its category, or vice-versa.
 */
describe('OrgNotificationSettingService.allowsForEmployee', () => {
  let service: OrgNotificationSettingService;
  let findOne: jest.Mock;

  const withRow = (row: any) => findOne.mockResolvedValue(row);

  beforeEach(async () => {
    findOne = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgNotificationSettingService,
        { provide: getRepositoryToken(OrgNotificationSettingEntity), useValue: { findOne } },
      ],
    }).compile();
    service = moduleRef.get(OrgNotificationSettingService);
  });

  it('no settings row → everything allowed', async () => {
    withRow(null);
    expect(await service.allowsForEmployee('o', 'leave_approved', 'email')).toBe(true);
  });

  it('category off suppresses all its events on that channel', async () => {
    withRow({ employeeCategories: { attendance: { email: false } }, employeeTypes: {} });
    expect(await service.allowsForEmployee('o', 'attendance_absent', 'email')).toBe(false);
    expect(await service.allowsForEmployee('o', 'attendance_absent', 'inApp')).toBe(true); // other channel untouched
  });

  it('a per-event override wins OVER the category default (event on, category off)', async () => {
    withRow({
      employeeCategories: { attendance: { email: false } },
      employeeTypes: { attendance_absent: { email: true } },
    });
    expect(await service.allowsForEmployee('o', 'attendance_absent', 'email')).toBe(true); // override wins
    expect(await service.allowsForEmployee('o', 'wfh_request_submitted', 'email')).toBe(false); // no override → category
  });

  it('a per-event override wins OVER the category default (event off, category on)', async () => {
    withRow({ employeeCategories: {}, employeeTypes: { attendance_daily_digest: { inApp: false } } });
    expect(await service.allowsForEmployee('o', 'attendance_daily_digest', 'inApp')).toBe(false);
    expect(await service.allowsForEmployee('o', 'attendance_absent', 'inApp')).toBe(true);
  });
});
