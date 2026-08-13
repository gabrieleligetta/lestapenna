import { ApiProperty } from '@nestjs/swagger';

/**
 * What the web app needs to know about the instance it is talking to, before
 * anybody has logged in.
 *
 * Everything here is already public: the same links live in `.github/FUNDING.yml`
 * and in the README. It exists as an endpoint rather than as a build-time
 * constant because a fork has to be able to point these elsewhere — or nowhere —
 * without recompiling the frontend, which is the same reason `LinksConfig`
 * exists on the bot side.
 */

/** The platforms this instance can name. Fixed, because each one has a mark drawn for it. */
export type DonationPlatform = 'github' | 'kofi';

export class DonationChannelDto {
    @ApiProperty({
        enum: ['github', 'kofi'],
        description: 'Which platform, so the button can show that platform’s own mark.',
    })
    platform!: DonationPlatform;

    @ApiProperty({ description: 'Where it points. Channels with no URL are not returned at all.' })
    url!: string;

    @ApiProperty({
        description:
            'False when the URL exists but does not accept money yet: the UI names the ' +
            'channel without making it clickable.',
    })
    active!: boolean;
}

export class AppInfoDto {
    @ApiProperty({
        type: [DonationChannelDto],
        description:
            'Every channel this instance offers, in display order. Empty when it asks for ' +
            'nothing — a fork that wants no donations configures no URL and the bar shows none.',
    })
    donations!: DonationChannelDto[];

    @ApiProperty()
    repo_url!: string;

    @ApiProperty({ example: 'AGPL-3.0' })
    license!: string;
}
