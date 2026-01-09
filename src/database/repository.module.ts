import { Module, Global } from '@nestjs/common';
import { DatabaseModule } from './database.module';
import { SessionRepository } from '../session/session.repository';
import { CampaignRepository } from '../campaign/campaign.repository';
import { RecordingRepository } from '../audio/recording.repository';
import { CharacterRepository } from '../character/character.repository';
import { LoreRepository } from '../lore/lore.repository';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    SessionRepository,
    CampaignRepository,
    RecordingRepository,
    CharacterRepository,
    LoreRepository
  ],
  exports: [
    SessionRepository,
    CampaignRepository,
    RecordingRepository,
    CharacterRepository,
    LoreRepository
  ],
})
export class RepositoryModule {}
