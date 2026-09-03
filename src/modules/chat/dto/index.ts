import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
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
