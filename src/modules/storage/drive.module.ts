import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { StorageModule } from '../../bootstrap/storage/storage.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { DocumentFileEntity } from '../../bootstrap/storage/document-file.entity';
import { ConversationEntity } from '../chat/entities/conversation.entity';
import { MessageEntity } from '../chat/entities/message.entity';

import { DriveFolderEntity } from './entities/drive-folder.entity';
import { DriveFileEntity } from './entities/drive-file.entity';
import { DriveShareEntity } from './entities/drive-share.entity';
import { DriveQuotaEntity } from './entities/drive-quota.entity';
import { DriveService } from './drive.service';
import { DriveController } from './drive.controller';
import { DrivePublicController } from './drive-public.controller';
import { CloudDriveAccessGuard } from './cloud-drive-access.guard';
import { DriveAdminGuard } from './drive-admin.guard';
import { DriveChatBridge } from './drive-chat-bridge';
import {
  NoopOfficeConvertProvider,
  OFFICE_CONVERT_PROVIDER,
} from './office-convert.provider';

/**
 * Cloud Drive — per-tenant file vault (folders, files, quotas, external shares).
 * Postgres/TypeORM port of the legacy Mongo `storage` module. Mounted under
 * `/api/v1/storage`; the bootstrap media surface owns `/media`.
 *
 * Byte delegation: the drive stores only metadata — the actual bytes live in the
 * shared bootstrap `StorageService` (S3 with a bytea fallback), referenced by
 * `storageFileId`. No second byte store, and no presigned URLs: every download
 * streams through the authenticated proxy.
 *
 * Office→PDF preview is a pluggable seam (`OFFICE_CONVERT_PROVIDER`) defaulting to
 * a no-op — PDFs preview directly, other office types report "not convertible".
 */
@Module({
  imports: [
    AuthModule, // JwtAuthGuard machinery (JwtService + TokenRevocationService)
    NotificationModule, // NotifierService (access-granted notification)
    StorageModule, // shared byte store (StorageService)
    TypeOrmModule.forFeature([
      DriveFolderEntity,
      DriveFileEntity,
      DriveShareEntity,
      DriveQuotaEntity,
      OrgMembershipEntity, // per-user grant + quota override (cloudDrive jsonb)
      DocumentFileEntity, // shared byte store — read to bridge chat/onboarding files
      ConversationEntity, // read-only: route a chat file by DM vs group
      MessageEntity, // read-only: message-driven backfill of sent attachments
    ]),
  ],
  controllers: [DriveController, DrivePublicController],
  providers: [
    DriveService,
    DriveChatBridge, // indexes chat attachments into Team Drive as they're sent
    CloudDriveAccessGuard,
    DriveAdminGuard,
    { provide: OFFICE_CONVERT_PROVIDER, useClass: NoopOfficeConvertProvider },
  ],
  exports: [DriveService],
})
export class DriveModule {}
