import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountController } from './account/account.controller';
import { AlertEngine } from './alerts/alert-engine.service';
import { AlertsController } from './alerts/alerts.controller';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { BillingController } from './billing/billing.controller';
import { AccessService } from './common/access.service';
import { AuditService } from './common/audit.service';
import { AuthGuard } from './common/auth.guard';
import { MailService } from './common/mail.service';
import { UsageService } from './common/usage.service';
import { AppConfig, CONFIG } from './config';
import { DashboardController } from './dashboard/dashboard.controller';
import { Db } from './db/db.service';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { EventsController } from './events/events.controller';
import { EventsService } from './events/events.service';
import { HealthController } from './health/health.controller';
import { OrganizationsController } from './organizations/organizations.controller';
import { RecordingsController } from './recordings/recordings.controller';
import { RecordingsService } from './recordings/recordings.service';
import { RetentionService } from './retention/retention.service';
import { SummariesController } from './summaries/summaries.controller';
import { SummaryService } from './summaries/summary.service';

@Global()
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
          // Automated tests make many logins from one IP; they opt in to
          // rate limiting explicitly with this header to test the real limits.
          skipIf: (ctx) =>
            config.env === 'test' && ctx.switchToHttp().getRequest().headers['x-test-rate-limit'] !== 'on',
        }),
      ],
      controllers: [
        AuthController,
        AccountController,
        DevicesController,
        EventsController,
        AlertsController,
        RecordingsController,
        OrganizationsController,
        AuditController,
        BillingController,
        SummariesController,
        DashboardController,
        HealthController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        Db,
        AccessService,
        AuditService,
        MailService,
        UsageService,
        AuthService,
        AlertEngine,
        DevicesService,
        EventsService,
        RecordingsService,
        SummaryService,
        RetentionService,
        // Order matters: rate limit first, then authenticate.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [Db, CONFIG],
    };
  }
}
