import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminPlaybooksController } from './admin-playbooks.controller';
import { AdminPlaybooksService } from './admin-playbooks.service';

/**
 * Super-admin migration playbooks. Imports AuthModule for the JWT + platform-admin
 * guards that protect the routes.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminPlaybooksController],
  providers: [AdminPlaybooksService],
})
export class AdminPlaybooksModule {}
