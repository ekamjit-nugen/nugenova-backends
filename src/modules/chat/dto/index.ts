import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── conversations ────────────────────────────────────────────────────────────

export class CreateDirectDto {
  @IsString()
  targetUserId: string;
}

export class CreateGroupDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  memberIds: string[];
}

export class CreateChannelDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  memberIds?: string[];

  @IsOptional()
  @IsEnum(['public', 'private', 'announcement', 'shared'])
  channelType?: string;

  @IsOptional()
  @IsString()
  topic?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;
}

export class UpdateChannelDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  topic?: string;

  @IsOptional()
  @IsString()
  icon?: string;
}

export class AddParticipantsDto {
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}

export class ConvertToGroupDto {
  @IsArray()
  @IsString({ each: true })
  memberIds: string[];

  @IsOptional()
  @IsString()
  groupName?: string;
}

export class MarkUnreadDto {
  @IsString()
  fromMessageId: string;
}

// ── messages ─────────────────────────────────────────────────────────────────

/**
 * One @mention the client attaches to a send. The shared FE↔BE contract:
 *   - `user` → `targetId` is the mentioned user's userId.
 *   - `here` / `all` → broadcast to the conversation's participants; `targetId`
 *     is the conversationId (or may be empty — the server resolves recipients
 *     from the conversation regardless).
 * NOTE: main.ts runs `forbidNonWhitelisted`, so this DTO field is REQUIRED for
 * the frontend to be allowed to send mentions at all.
 */
export class MentionDto {
  @IsEnum(['user', 'here', 'all'])
  type: 'user' | 'here' | 'all';

  @IsString()
  targetId: string;
}

export class SendMessageDto {
  // No length cap — messages may be arbitrarily long.
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsEnum([
    'text',
    'file',
    'image',
    'video',
    'audio',
    'code',
    'system',
    'call',
    'meeting',
    'poll',
    'card',
    'forwarded',
  ])
  type?: string;

  @IsOptional()
  @IsString()
  replyTo?: string;

  @IsOptional()
  @IsString()
  threadId?: string;

  // Attachment metadata (from a prior /media/upload).
  @IsOptional()
  @IsString()
  fileUrl?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  fileSize?: number;

  @IsOptional()
  @IsString()
  fileMimeType?: string;

  @IsOptional()
  @IsString()
  fileId?: string;

  // Client-supplied idempotency key — de-dupes genuine double-fires without
  // collapsing intentional repeats. Absent it, the service falls back to a
  // content+time-bucket hash.
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  // @mentions attached to this message. Nested-validated so a malformed entry is
  // rejected rather than silently stored.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MentionDto)
  mentions?: MentionDto[];
}

export class EditMessageDto {
  @IsString()
  content: string;
}

export class MessageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;

  // Result order by createdAt. Default 'asc' (oldest-first) — the web relies on
  // this. Clients paging from newest backwards pass 'desc'.
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class SearchMessageDto {
  @IsString()
  q: string;
}
