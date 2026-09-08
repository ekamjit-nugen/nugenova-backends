/* eslint-disable @typescript-eslint/no-explicit-any */
import { FindOperator } from 'typeorm';
import { newObjectId } from '../../../bootstrap/database/object-id';

/**
 * Minimal in-memory stand-in for a TypeORM Repository, for UNIT specs only.
 * Supports the slice of the API AiChatService/AiJobService actually use:
 * create/save/find/findOne/update/delete with equality, `In(...)` and
 * `LessThan(...)` matchers, `undefined` conditions skipped (TypeORM semantics),
 * array `where` treated as OR, and single-key ordering.
 */
export class FakeRepo<T extends { id: string; createdAt?: Date; updatedAt?: Date }> {
  rows: T[] = [];

  create(obj: Partial<T>): T {
    return { ...(obj as any) } as T;
  }

  async save(entity: T): Promise<T> {
    if (!entity.id) (entity as any).id = newObjectId();
    if (!entity.createdAt) (entity as any).createdAt = new Date();
    (entity as any).updatedAt = new Date();
    const existing = this.rows.findIndex((r) => r.id === entity.id);
    if (existing >= 0) this.rows[existing] = entity;
    else this.rows.push(entity);
    return entity;
  }

  async find(opts?: { where?: any; order?: any }): Promise<T[]> {
    let out = this.rows.filter((r) => matchWhere(r, opts?.where));
    if (opts?.order) out = applyOrder(out, opts.order);
    return out;
  }

  async findOne(opts: { where?: any }): Promise<T | null> {
    return this.rows.find((r) => matchWhere(r, opts.where)) ?? null;
  }

  async update(criteria: any, patch: Partial<T>): Promise<{ affected: number }> {
    const matched = this.rows.filter((r) => matchWhere(r, criteria));
    for (const r of matched) Object.assign(r, patch);
    return { affected: matched.length };
  }

  async delete(criteria: any): Promise<{ affected: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matchWhere(r, criteria));
    return { affected: before - this.rows.length };
  }
}

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  if (Array.isArray(where)) return where.some((w) => matchWhere(row, w));
  return Object.entries(where).every(([k, cond]) => matchValue(row[k], cond));
}

function matchValue(rowVal: any, cond: any): boolean {
  if (cond === undefined) return true; // TypeORM skips undefined conditions
  if (cond instanceof FindOperator) {
    const type = (cond as any)._type;
    const value = (cond as any)._value;
    if (type === 'in') return Array.isArray(value) && value.includes(rowVal);
    if (type === 'lessThan') return rowVal != null && rowVal < value;
    throw new Error(`FakeRepo: unsupported FindOperator '${type}'`);
  }
  return rowVal === cond;
}

function applyOrder<T>(rows: T[], order: Record<string, 'ASC' | 'DESC'>): T[] {
  const keys = Object.keys(order);
  return [...rows].sort((a: any, b: any) => {
    for (const k of keys) {
      const dir = order[k] === 'DESC' ? -1 : 1;
      const av = a[k] ?? 0;
      const bv = b[k] ?? 0;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}
