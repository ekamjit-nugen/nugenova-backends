import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Not, Repository } from 'typeorm';

import { HolidayEntity } from '../attendance/entities/holiday.entity';
import { LeaveRequestEntity } from '../leave/entities/leave-request.entity';
import { MeetingEntity } from '../meetings/entities/meeting.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

export interface CalendarCaller {
  userId: string;
  isAdmin: boolean;
}

export type CalendarEventType = 'holiday' | 'leave' | 'wfh' | 'meeting' | 'birthday';

export interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  title: string;
  /** ISO — `YYYY-MM-DD` for all-day events, full ISO datetime for meetings. */
  start: string;
  end: string;
  allDay: boolean;
  meta?: Record<string, unknown>;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const LEAVE_LABEL: Record<string, string> = {
  casual: 'Casual leave', sick: 'Sick leave', earned: 'Earned leave', wfh: 'WFH',
  maternity: 'Maternity', paternity: 'Paternity', bereavement: 'Bereavement',
  comp_off: 'Comp-off', lop: 'Unpaid leave',
};

/**
 * Read-only calendar aggregator — one org-scoped feed combining holidays, who's
 * on approved leave, the caller's meetings, and team birthdays for a date range.
 */
@Injectable()
export class CalendarService {
  constructor(
    @InjectRepository(HolidayEntity) private readonly holidays: Repository<HolidayEntity>,
    @InjectRepository(LeaveRequestEntity) private readonly leaves: Repository<LeaveRequestEntity>,
    @InjectRepository(MeetingEntity) private readonly meetings: Repository<MeetingEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
  ) {}

  async getEvents(orgId: string, caller: CalendarCaller, from: Date, to: Date): Promise<CalendarEvent[]> {
    const people = await this.orgPeople(orgId);
    const [holidays, leaves, meetings, birthdays] = await Promise.all([
      this.holidayEvents(orgId, from, to),
      this.leaveEvents(orgId, from, to, people),
      this.meetingEvents(orgId, caller, from, to),
      this.birthdayEvents(from, to, people),
    ]);
    return [...holidays, ...leaves, ...meetings, ...birthdays];
  }

  /** Active-member userId → { display name, date of birth } for the org. */
  private async orgPeople(orgId: string): Promise<Map<string, { name: string; dob: Date | null }>> {
    const map = new Map<string, { name: string; dob: Date | null }>();
    const mems = await this.memberships.find({ where: { organizationId: orgId, status: 'active' } });
    const ids = [...new Set(mems.map((m) => m.userId).filter((x): x is string => !!x))];
    if (!ids.length) return map;
    const users = await this.users.find({ where: { id: In(ids) } });
    for (const u of users) {
      map.set(u.id, {
        name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Someone',
        dob: u.dateOfBirth ?? null,
      });
    }
    return map;
  }

  private async holidayEvents(orgId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
    const rows = await this.holidays.find({ where: { organizationId: orgId, isDeleted: false, date: Between(from, to) } });
    return rows.map((h) => ({
      id: `holiday:${h.id}`, type: 'holiday', title: h.name, start: ymd(h.date), end: ymd(h.date),
      allDay: true, meta: { holidayType: h.type },
    }));
  }

  private async leaveEvents(orgId: string, from: Date, to: Date, people: Map<string, { name: string }>): Promise<CalendarEvent[]> {
    // Approved leaves overlapping the window.
    const rows = await this.leaves.find({
      where: { organizationId: orgId, status: 'approved', startDate: LessThanOrEqual(to), endDate: MoreThanOrEqual(from) },
    });
    return rows.map((l) => {
      const name = people.get(l.userId)?.name || l.employeeName || 'Someone';
      const isWfh = l.leaveType === 'wfh';
      return {
        id: `leave:${l.id}`, type: (isWfh ? 'wfh' : 'leave') as CalendarEventType,
        title: `${name} · ${isWfh ? 'WFH' : LEAVE_LABEL[l.leaveType] || l.leaveType}${l.halfDay ? ' (half day)' : ''}`,
        start: ymd(l.startDate), end: ymd(l.endDate), allDay: true,
        meta: { userId: l.userId, leaveType: l.leaveType, halfDay: l.halfDay },
      };
    });
  }

  private async meetingEvents(orgId: string, caller: CalendarCaller, from: Date, to: Date): Promise<CalendarEvent[]> {
    const rows = await this.meetings.find({
      where: { organizationId: orgId, isDeleted: false, status: Not('cancelled') },
    });
    const accessible = rows.filter((m) =>
      !!m.scheduledStart && (caller.isAdmin || m.hostId === caller.userId || (m.participants ?? []).some((p) => p.userId === caller.userId)),
    );
    const events: CalendarEvent[] = [];
    for (const m of accessible) {
      const base = m.scheduledStart as Date;
      const durationMs = m.scheduledEnd ? m.scheduledEnd.getTime() - base.getTime() : 60 * 60 * 1000;
      for (const occ of this.expandOccurrences(base, m.recurrence, from, to)) {
        events.push({
          id: `meeting:${m.id}:${occ.getTime()}`, type: 'meeting', title: m.title,
          start: occ.toISOString(), end: new Date(occ.getTime() + durationMs).toISOString(), allDay: false,
          meta: { meetingId: m.id, status: m.status, recurrence: m.recurrence, host: m.hostName },
        });
      }
    }
    return events;
  }

  /** Occurrence dates of a (possibly recurring) meeting within [from,to]. */
  private expandOccurrences(base: Date, recurrence: string, from: Date, to: Date): Date[] {
    if (!recurrence || recurrence === 'none') {
      return base >= from && base <= to ? [base] : [];
    }
    const stepMs = recurrence === 'weekly' ? 7 * 86400000 : 86400000;
    const out: Date[] = [];
    // Fast-forward to the first occurrence at/after `from`.
    let t = base.getTime();
    if (t < from.getTime()) {
      const skip = Math.floor((from.getTime() - t) / stepMs);
      t += skip * stepMs;
      if (t < from.getTime()) t += stepMs;
    }
    for (let i = 0; t <= to.getTime() && i < 400; i++, t += stepMs) out.push(new Date(t));
    return out;
  }

  private birthdayEvents(from: Date, to: Date, people: Map<string, { name: string; dob: Date | null }>): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    for (const [userId, p] of people) {
      if (!p.dob) continue;
      const dob = new Date(p.dob);
      for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year++) {
        const day = new Date(Date.UTC(year, dob.getUTCMonth(), dob.getUTCDate()));
        if (day >= from && day <= to) {
          events.push({
            id: `birthday:${userId}:${year}`, type: 'birthday', title: `${p.name}'s birthday 🎂`,
            start: ymd(day), end: ymd(day), allDay: true, meta: { userId },
          });
        }
      }
    }
    return events;
  }
}
