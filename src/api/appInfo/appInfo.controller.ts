import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { config } from '../../config';
import { AppInfoDto, DonationChannelDto } from './appInfo.dto';

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
        const channels: DonationChannelDto[] = [
            { platform: 'kofi' as const, url: config.links.kofiUrl, active: config.links.kofiActive },
            { platform: 'github' as const, url: config.links.donationUrl, active: config.links.donationActive },
        ];

        return {
            // A channel with no URL is dropped rather than returned inert: the
            // inert state means "declared but not open yet", and a fork that
            // simply does not use Ko-fi is not waiting for anything.
            donations: channels
                .filter(channel => Boolean(channel.url))
                // An empty URL is already "no donation at all", so it can never
                // be active: two flags that could disagree would eventually
                // render a live link to nowhere.
                .map(channel => ({ ...channel, active: Boolean(channel.url) && channel.active })),
            repo_url: config.links.repoUrl,
            license: 'AGPL-3.0',
        };
    }
}
