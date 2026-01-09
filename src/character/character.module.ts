import { Module } from '@nestjs/common';
import { CharacterService } from './character.service';
import { CharacterCommands } from './character.commands';
import { CampaignModule } from '../campaign/campaign.module';

@Module({
  imports: [CampaignModule],
  providers: [CharacterService, CharacterCommands],
  exports: [CharacterService],
})
export class CharacterModule {}
