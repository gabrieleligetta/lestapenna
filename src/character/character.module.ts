import { Module } from '@nestjs/common';
import { CharacterService } from './character.service';
import { CharacterCommands } from './character.commands';
import { DatabaseModule } from '../database/database.module';
import { CampaignModule } from '../campaign/campaign.module';
import { CharacterRepository } from './character.repository';

@Module({
  imports: [DatabaseModule, CampaignModule],
  providers: [CharacterService, CharacterCommands, CharacterRepository],
  exports: [CharacterService, CharacterRepository],
})
export class CharacterModule {}
