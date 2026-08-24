import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../../modules/auth/auth.module';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { DocumentFileEntity } from './document-file.entity';

/**
 * Global file storage (S3 with a Postgres-bytea fallback). Owns `document_files`
 * and exposes the `/media` upload/download surface. Imports AuthModule so its
 * controller can use JwtAuthGuard (JwtService + TokenRevocationService).
 */
@Global()
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([DocumentFileEntity])],
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService, TypeOrmModule],
})
export class StorageModule {}
