import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Audit } from './core/audit';
import { AuthGuard } from './core/auth';
import { Db } from './core/db';
import { AllExceptionsFilter } from './core/errors';
import { Idempotency, RequestContextMiddleware } from './core/http';
import { VaultClient } from './core/vault-client';
import { AdminController, AuthController, MetaController } from './modules/admin';
import { AutoReportController } from './modules/autoreport';
import { DsrController } from './modules/betroffenenrechte';
import { CasesController } from './modules/cases';
import { ConsentController, ConsentService } from './modules/consent';
import { FollowUpService } from './modules/followup.service';
import { FormsController } from './modules/forms';
import { HealthController } from './modules/health';
import { MigrationController } from './modules/migration';
import { PortalController } from './modules/portal';
import { ExportsController, ReportsController } from './modules/reports';
import { ResponsesController, ResponsesService } from './modules/responses';
import { ContactPreferenceController, DispatchController } from './modules/versand';

/** Modularer Monolith: Fachmodule teilen Datenbankzugriff, Audit und Rechteprüfung. */
@Module({
  controllers: [
    HealthController,
    AuthController,
    MetaController,
    AdminController,
    CasesController,
    ConsentController,
    ResponsesController,
    FormsController,
    PortalController,
    ReportsController,
    AutoReportController,
    ExportsController,
    MigrationController,
    DispatchController,
    ContactPreferenceController,
    DsrController,
  ],
  providers: [
    Db,
    Audit,
    VaultClient,
    Idempotency,
    FollowUpService,
    ConsentService,
    ResponsesService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
