import { Module } from '@nestjs/common';
import { CharacterService } from './character.service';
import { CharacterCommands } from './character.commands';
import { DatabaseModule } from '../database/database.module';
import { CampaignModule } from '../campaign/campaign.module';

@Module({
  imports: [DatabaseModule, CampaignModule],
  providers: [CharacterService, CharacterCommands],
  exports: [CharacterService],
})
export class CharacterModule {}
