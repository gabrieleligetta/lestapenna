import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignsController } from './campaigns.controller';
import { PartyController } from './party.controller';
import { CampaignAccessGuard } from './campaignAccess.guard';
import { CampaignWriteGuard } from './campaignWrite.guard';
import { EntityMediaController } from './entityMedia.controller';
import { EntityMediaService } from './entityMedia.service';
import { ImageGenerationService } from './imageGeneration.service';
import { EntityProfileService } from './entityProfile.service';
import { ReferenceImagesService } from './referenceImages.service';
import { MergeService } from './merge/merge.service';
import { EntityCrudController } from './crud/entity-crud.controller';
import { EntityCrudService } from './crud/entity-crud.service';
import { AskController } from './ask/ask.controller';
import { AskService } from './ask/ask.service';
import { CampaignTableController } from './table.controller';
import { CampaignMasterGuard } from './campaignMaster.guard';
import { CharactersController } from './characters.controller';
import { CharacterBioService } from './characterBio.service';
import { QuestAuditService } from './questAudit.service';
import { AiJobsController } from './aiJobs.controller';
import { MyAiJobsController } from './myAiJobs.controller';
import { AiJobsService } from './aiJobs.service';
import { AiJobRunnerProvider } from '../aiJobs/aiJobRunner.provider';

@Module({
    imports: [AuthModule],
    // CampaignsController stays first: its specific routes
    // (`:campaignId/npcs/:shortId`) are evaluated before the CRUD's
    // parametric ones (`:campaignId/:entityType/:shortId`).
    // For the same reason AskController precedes the CRUD: `:campaignId/ask/...`
    // would otherwise be read as `:entityType = 'ask'`.
    controllers: [
        CampaignsController,
        PartyController,
        EntityMediaController,
        AskController,
        // Before the CRUD controller, whose `:campaignId/:entityType/:shortId`
        // would otherwise read `ai-jobs` as a kind of entity — the same reason
        // AskController sits where it does.
        AiJobsController,
        MyAiJobsController,
        CampaignTableController,
        CharactersController,
        EntityCrudController,
    ],
    providers: [
        CampaignAccessGuard,
        CampaignWriteGuard,
        CampaignMasterGuard,
        EntityMediaService,
        ImageGenerationService,
        EntityProfileService,
        ReferenceImagesService,
        MergeService,
        EntityCrudService,
        AskService,
        AiJobsService,
        QuestAuditService,
        CharacterBioService,
        AiJobRunnerProvider,
    ],
    exports: [EntityMediaService, MergeService],
})
export class CampaignsModule {}
