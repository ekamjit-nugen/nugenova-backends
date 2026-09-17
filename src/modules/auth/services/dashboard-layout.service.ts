import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

/**
 * How one person arranged their dashboard: the order of its sections and which
 * they hid. Section ids belong to the frontend, which decides what exists and
 * what each person may see; ids it no longer knows are simply skipped there.
 */
export interface DashboardLayout {
  order: string[];
  hidden: string[];
}

const SECTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_SECTIONS = 40;

/** Keep only well-formed, unique ids — a layout can never grow unbounded or carry markup. */
export function sanitizeDashboardLayout(input: unknown): DashboardLayout {
  const body = (input ?? {}) as Partial<Record<keyof DashboardLayout, unknown>>;
  const list = (value: unknown, field: keyof DashboardLayout): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new BadRequestException(`"${field}" must be a list of section ids`);
    const ids = [...new Set(value.filter((v): v is string => typeof v === 'string' && SECTION_ID.test(v)))];
    if (ids.length > MAX_SECTIONS) throw new BadRequestException(`"${field}" has too many sections`);
    return ids;
  };
  return { order: list(body.order, 'order'), hidden: list(body.hidden, 'hidden') };
}

/**
 * DashboardLayoutService — stored per user in `users.preferences.dashboard`, so
 * it follows them across devices. No migration: `preferences` is existing jsonb.
 */
@Injectable()
export class DashboardLayoutService {
  constructor(@InjectRepository(UserEntity) private readonly users: Repository<UserEntity>) {}

  async get(userId: string): Promise<DashboardLayout> {
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, preferences: true } });
    const saved = user?.preferences?.['dashboard'];
    try {
      return sanitizeDashboardLayout(saved);
    } catch {
      return { order: [], hidden: [] };
    }
  }

  async set(userId: string, input: unknown): Promise<DashboardLayout> {
    const layout = sanitizeDashboardLayout(input);
    // Merge into preferences in ONE statement: other keys (e.g. chatHoliday, set
    // by chat presence) must survive a concurrent write.
    await this.users
      .createQueryBuilder()
      .update(UserEntity)
      .set({
        preferences: () => `COALESCE("preferences", '{}'::jsonb) || jsonb_build_object('dashboard', CAST(:layout AS jsonb))`,
      })
      .setParameter('layout', JSON.stringify(layout))
      .where('id = :id', { id: userId })
      .execute();
    return layout;
  }
}
