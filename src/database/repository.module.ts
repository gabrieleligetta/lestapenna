import { Module, Global } from '@nestjs/common';
import { DatabaseModule } from './database.module';
import { SessionRepository } from '../session/session.repository';
import { CampaignRepository } from '../campaign/campaign.repository';
import { RecordingRepository } from '../audio/recording.repository';
import { CharacterRepository } from '../character/character.repository';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    SessionRepository,
    CampaignRepository,
    RecordingRepository,
    CharacterRepository
  ],
  exports: [
    SessionRepository,
    CampaignRepository,
    RecordingRepository,
    CharacterRepository
  ],
})
export class RepositoryModule {}
