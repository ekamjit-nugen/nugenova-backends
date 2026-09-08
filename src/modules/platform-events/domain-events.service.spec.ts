import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DomainEventsService } from './domain-events.service';
import { DOMAIN_EVENTS } from './domain-events';

/**
 * Pure unit specs — no bus wiring, a mocked EventEmitter2. These pin the two
 * guarantees the typed wrapper adds over the raw emitter: it stamps a resolved
 * envelope (`event` + `occurredAt`), and it NEVER throws — a listener/bus error
 * is swallowed so the emitting transaction is never broken.
 */
describe('DomainEventsService (unit, no bus)', () => {
  let service: DomainEventsService;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    emitter = { emit: jest.fn().mockReturnValue(true) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        DomainEventsService,
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = moduleRef.get(DomainEventsService);
  });

  it('emits on the canonical wire name with an enveloped payload', () => {
    const ok = service.emit(DOMAIN_EVENTS.ENROLMENT_CREATED, {
      organizationId: 'org1',
      enrolmentId: 'e1',
      classId: 'c1',
      studentMembershipId: 'm1',
    });
    expect(ok).toBe(true);
    expect(emitter.emit).toHaveBeenCalledTimes(1);
    const [name, envelope] = emitter.emit.mock.calls[0];
    expect(name).toBe('enrolment.created');
    expect(envelope).toEqual(
      expect.objectContaining({
        event: 'enrolment.created',
        organizationId: 'org1',
        enrolmentId: 'e1',
        classId: 'c1',
        studentMembershipId: 'm1',
      }),
    );
    expect(envelope.occurredAt).toBeInstanceOf(Date);
  });

  it('preserves a caller-provided occurredAt', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    service.emit(DOMAIN_EVENTS.FEE_OVERDUE, {
      organizationId: 'org1',
      subjectMembershipId: 'm1',
      invoiceId: 'inv1',
      amountDue: 100,
      dueDate: '2026-01-01',
      occurredAt: when,
    });
    expect(emitter.emit.mock.calls[0][1].occurredAt).toBe(when);
  });

  it('never throws when the underlying emitter blows up (returns false)', () => {
    emitter.emit.mockImplementation(() => {
      throw new Error('listener exploded');
    });
    let result: boolean | undefined;
    expect(() => {
      result = service.emit(DOMAIN_EVENTS.ATTENDANCE_MARKED, {
        organizationId: 'org1',
        membershipId: 'm1',
        date: '2026-01-01',
        status: 'present',
      });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('exposes every plan event name in the registry', () => {
    const names = Object.values(DOMAIN_EVENTS);
    expect(names).toEqual(
      expect.arrayContaining([
        'attendance.marked',
        'attendance.shortfall',
        'fee.overdue',
        'enquiry.created',
        'enquiry.stale',
        'assessment.graded',
        'document.expiring',
        'admission.confirmed',
        'enrolment.created',
      ]),
    );
  });
});
