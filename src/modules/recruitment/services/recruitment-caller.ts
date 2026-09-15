import { ForbiddenException } from '@nestjs/common';
import { UserEntity } from '../../auth/entities/user.entity';
import { RECRUITMENT_RESOURCE } from '../recruitment.constants';

/** The acting user, derived from the JWT only (never from the client body). */
export interface RecruitmentCaller {
  userId: string;
  orgId: string;
  isAdmin: boolean;
  /** Actions the caller holds on the `recruitment` resource. */
  actions: string[];
}

export type RecruitmentAction = 'view' | 'create' | 'edit' | 'delete' | 'export' | 'assign';

/** Build a caller from `req.user` (populated by JwtAuthGuard). */
export function callerFromRequest(req: any): RecruitmentCaller {
  const u = req?.user;
  const orgId = u?.organizationId;
  if (!orgId) throw new ForbiddenException('No organization context');
  const isAdmin = u?.orgRole === 'owner' || u?.orgRole === 'admin';
  const actions = Array.isArray(u?.perms?.[RECRUITMENT_RESOURCE]) ? (u.perms[RECRUITMENT_RESOURCE] as string[]) : [];
  return { userId: u.userId, orgId, isAdmin, actions };
}

export function can(caller: RecruitmentCaller, action: RecruitmentAction): boolean {
  return caller.isAdmin || caller.actions.includes(action);
}

export function assertCan(caller: RecruitmentCaller, action: RecruitmentAction): void {
  if (!can(caller, action)) throw new ForbiddenException(`You don't have permission to ${action} recruitment`);
}

export const nameOf = (u?: Pick<UserEntity, 'firstName' | 'lastName' | 'email'> | null): string =>
  u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Member' : 'Member';

/** numeric column (string) → number | null */
export const toNum = (v: string | number | null | undefined): number | null =>
  v == null || v === '' ? null : Number(v);
