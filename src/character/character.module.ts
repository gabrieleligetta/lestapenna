import { Module } from '@nestjs/common';
import { CharacterService } from './character.service';
import { CharacterCommands } from './character.commands';
import { DatabaseModule } from '../database/database.module';
import { CampaignModule } from '../campaign/campaign.module';
import { AiModule } from '../ai/ai.module';
import { LoreModule } from '../lore/lore.module';

@Module({
  imports: [DatabaseModule, CampaignModule, AiModule, LoreModule],
  providers: [CharacterService, CharacterCommands],
  exports: [CharacterService],
})
export class CharacterModule {}
