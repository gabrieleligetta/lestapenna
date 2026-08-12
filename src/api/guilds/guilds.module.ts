import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GuildsController } from './guilds.controller';

@Module({
    imports: [AuthModule],
    controllers: [GuildsController],
})
export class GuildsModule {}
