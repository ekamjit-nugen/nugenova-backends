import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const SCOPES = ['personal', 'team'] as const;

// ── folders ──────────────────────────────────────────────────────────────────

export class CreateFolderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsIn(SCOPES)
  scope?: 'personal' | 'team';

  @IsOptional()
  @IsString()
  parentId?: string | null;
}

export class RenameFolderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsIn(SCOPES)
  scope?: 'personal' | 'team';
}

export class MoveFolderDto {
  @IsOptional()
  @IsIn(SCOPES)
  scope?: 'personal' | 'team';

  @IsOptional()
  @IsString()
  targetParentId?: string | null;
}

// ── files ────────────────────────────────────────────────────────────────────

export class RenameFileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsIn(SCOPES)
  scope?: 'personal' | 'team';
}

export class MoveFileDto {
  @IsOptional()
  @IsIn(SCOPES)
  scope?: 'personal' | 'team';

  @IsOptional()
  @IsString()
  targetFolderId?: string | null;
}

// ── shares ───────────────────────────────────────────────────────────────────

export class CreateShareDto {
  @IsIn(['file', 'folder'])
  targetType: 'file' | 'folder';

  @IsString()
  targetId: string;

  @IsOptional()
  @IsIn(SCOPES)
  scope?: 'personal' | 'team';

  @IsOptional()
  @IsIn(['view', 'download'])
  permission?: 'view' | 'download';

  @IsOptional()
  @IsString()
  password?: string | null;

  @IsOptional()
  @IsString()
  expiresAt?: string | null;
}

export class OpenShareDto {
  @IsOptional()
  @IsString()
  password?: string;
}

export class ListShareDto {
  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  folderId?: string | null;
}

export class ShareDownloadDto {
  @IsOptional()
  @IsString()
  password?: string;

  @IsString()
  fileId: string;
}

// ── admin: access + settings ───────────────────────────────────────────────────

export class SetAccessDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  quotaGb?: number | null;
}

export class SetSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  defaultUserQuotaGb?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  quotaGb?: number;
}

// ── internal grants (share with org members) ────────────────────────────────

const GRANT_PERMS = ['view', 'download', 'edit'] as const;

export class CreateGrantDto {
  @IsIn(['file', 'folder'])
  targetType: 'file' | 'folder';

  @IsString()
  targetId: string;

  @IsArray()
  @IsString({ each: true })
  granteeUserIds: string[];

  @IsIn(GRANT_PERMS)
  permission: 'view' | 'download' | 'edit';
}
