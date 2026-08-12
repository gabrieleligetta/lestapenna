import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AiScopeInterceptor } from './auth/aiScope.interceptor';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { GuildsModule } from './guilds/guilds.module';
import { AiSettingsModule } from './aiSettings/aiSettings.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ReportsModule } from './reports/reports.module';
import { AppInfoModule } from './appInfo/appInfo.module';
import { LandingModule } from './landing/landing.module';

@Module({
    // AuthModule before LandingModule: it registers @fastify/cookie in
    // onModuleInit, and LandingModule's catch-all (@All('*')) must not
    // shadow /api/v1/* routes — Nest matches routes in registration order.
    imports: [HealthModule, AuthModule, GuildsModule, AiSettingsModule, CampaignsModule, ReportsModule, AppInfoModule, LandingModule],
    // Global on purpose: an AI route added in the future inherits the table's
    // scope without anyone having to remember it.
    providers: [{ provide: APP_INTERCEPTOR, useClass: AiScopeInterceptor }],
})
export class AppModule {}
