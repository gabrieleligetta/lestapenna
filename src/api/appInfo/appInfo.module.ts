import { Module } from '@nestjs/common';
import { AppInfoController } from './appInfo.controller';

@Module({
    controllers: [AppInfoController],
})
export class AppInfoModule {}
