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

export class DonationInfoDto {
    @ApiProperty({ description: 'Empty when this instance asks for nothing.' })
    url!: string;

    @ApiProperty({
        description:
            'False when the URL exists but does not accept money yet: the UI names the ' +
            'channel without making it clickable.',
    })
    active!: boolean;
}

export class AppInfoDto {
    @ApiProperty({ type: DonationInfoDto })
    donation!: DonationInfoDto;

    @ApiProperty()
    repo_url!: string;

    @ApiProperty({ example: 'AGPL-3.0' })
    license!: string;
}
