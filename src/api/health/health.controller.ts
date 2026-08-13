import { Controller, Get } from '@nestjs/common';
import { getOperationalHealth } from '../../services/operationalHealth';

@Controller('health')
export class HealthController {
    @Get()
    async check() {
        return getOperationalHealth();
    }
}
