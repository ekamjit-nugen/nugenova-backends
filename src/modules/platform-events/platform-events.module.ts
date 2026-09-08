import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { DomainEventsService } from './domain-events.service';

/**
 * PlatformEventsModule — §08 layer 1 foundation. Registers the app-wide event
 * bus (`EventEmitterModule.forRoot()`, ONCE — like ScheduleModule in app.module)
 * and exposes the typed `DomainEventsService` every feature module emits through.
 *
 * Marked @Global so any module can inject `DomainEventsService` without importing
 * this module explicitly. Nothing subscribes yet — this only provides the emit
 * seam the later automation layer binds listeners to. See PLAYBOOK.md.
 */
@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      // Fire-and-forget: a slow/failing listener must not block the emitter.
      // Errors inside listeners are additionally swallowed in DomainEventsService.
      wildcard: false,
      ignoreErrors: true,
    }),
  ],
  providers: [DomainEventsService],
  exports: [DomainEventsService],
})
export class PlatformEventsModule {}
