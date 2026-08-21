import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PostgresModule } from './bootstrap/database/postgres.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminPlaybooksModule } from './modules/admin-playbooks/admin-playbooks.module';

/**
 * Nugenova backend root module.
 *
 * Postgres-only. Migrated modules are added to the imports below one at a time
 * (auth first). ScheduleModule.forRoot() is registered ONCE here — feature
 * modules must not call it again.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    PostgresModule,
    ScheduleModule.forRoot(),
    HealthModule,
    // ── migrated modules land here ──
    AuthModule,
    AdminPlaybooksModule,
  ],
})
export class AppModule {}
