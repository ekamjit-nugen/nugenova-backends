import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * The org admin/owner's control panel over chat for EMPLOYEES. One row per org.
 * Every field defaults to the current permissive behaviour, so an org with no
 * row (or a partial one) behaves exactly as before — see `DEFAULT_CHAT_SETTINGS`.
 * Owners/admins are never restricted by these gates; they apply to members.
 */
export interface OrgChatSettings {
  // ── Access & availability ──
  /** Master switch. When false, members can't send or start conversations. */
  chatEnabled: boolean;
  /** Who a member may start a direct message with. */
  whoCanDm: 'everyone' | 'same_department' | 'admins';
  /** Who may create channels. */
  whoCanCreateChannels: 'everyone' | 'admins';
  /** Who may create group chats. */
  whoCanCreateGroups: 'everyone' | 'admins';
  /** Who may manage a group/channel (add/remove members, rename, change picture). */
  whoCanManageGroups: 'creator_and_admins' | 'any_member' | 'admins';
  /** Default state of the "share previous messages" toggle when adding a member. */
  shareHistoryDefault: boolean;

  // ── Attachments ──
  attachmentsEnabled: boolean;
  /** Max upload size in MB (also capped by the server's hard limit). */
  maxFileSizeMb: number;
  /** Lower-cased extensions members may NOT upload (e.g. ['exe','bat']). */
  blockedExtensions: string[];

  // ── Moderation & retention ──
  /** May a member edit their own messages? */
  allowEditOwn: boolean;
  /** May a member delete their own messages? */
  allowDeleteOwn: boolean;
  /** May an org admin/owner delete ANY message (moderation)? */
  adminCanDeleteAny: boolean;
  /** Auto-delete messages older than N days. 0 = keep forever. */
  retentionDays: number;

  // ── Broadcast ──
  /** Gate @everyone / @here broadcasts to admins/owners only. */
  broadcastAdminsOnly: boolean;
}

@Entity('org_chat_settings')
export class OrgChatSettingEntity extends PgBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  settings: Partial<OrgChatSettings>;
}
