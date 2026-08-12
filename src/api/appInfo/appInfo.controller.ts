import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { config } from '../../config';
import { AppInfoDto } from './appInfo.dto';

/**
 * The instance's public identity.
 *
 * Deliberately **unguarded**: the support bar sits on the login page too, and a
 * page reachable before authentication cannot read anything behind
 * `SessionGuard`. Nothing here is private — it is the licence, the repository
 * and the donation link, all three already published.
 */
@Controller('api/v1/app-info')
export class AppInfoController {
    @Get()
    @ApiOkResponse({ type: AppInfoDto })
    getAppInfo(): AppInfoDto {
        return {
            donation: {
                url: config.links.donationUrl,
                // An empty URL is already "no donation at all", so it can never
                // be active: two flags that could disagree would eventually
                // render a live link to nowhere.
                active: Boolean(config.links.donationUrl) && config.links.donationActive,
            },
            repo_url: config.links.repoUrl,
            license: 'AGPL-3.0',
        };
    }
}
