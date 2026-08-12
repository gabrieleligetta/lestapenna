import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
    // AuthModule provides SessionGuard; reports are user-scoped (no guild/campaign guard).
    imports: [AuthModule],
    controllers: [ReportsController],
    providers: [ReportsService],
})
export class ReportsModule {}