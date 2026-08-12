import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignAccessGuard } from '../campaigns/campaignAccess.guard';
import { CampaignWriteGuard } from '../campaigns/campaignWrite.guard';
import { AiSettingsController } from './aiSettings.controller';
import { AiSettingsService } from './aiSettings.service';

@Module({
    imports: [AuthModule],
    controllers: [AiSettingsController],
    // `CampaignAccessGuard` has to be declared here too: guards are resolved
    // from the injector of the module that uses them, and the "effective" route belongs to this one.
    providers: [AiSettingsService, CampaignAccessGuard, CampaignWriteGuard],
})
export class AiSettingsModule {}
