import { ApiProperty } from '@nestjs/swagger';
import { SUPPORTED_LOCALES } from '../../../i18n';

export class CampaignMemberDto {
    @ApiProperty({ description: 'Discord user id.' })
    user_id!: string;

    @ApiProperty({ enum: ['MASTER', 'PLAYER'] })
    role!: 'MASTER' | 'PLAYER';

    @ApiProperty({ nullable: true, description: 'Name of their character in this campaign, when they have one.' })
    character_name!: string | null;

    @ApiProperty({
        nullable: true,
        description: 'Discord nickname on this server, else the global name. Null when Discord cannot be reached.',
    })
    display_name!: string | null;

    @ApiProperty({ nullable: true, description: 'Discord @handle, when known.' })
    username!: string | null;

    @ApiProperty({
        description:
            'Whether they hold a seat in the campaign. False for someone who has a character here but was '
            + 'never enrolled (or was removed): they show up in the list so a master can put them back.',
    })
    enrolled!: boolean;

    @ApiProperty({ nullable: true })
    added_at!: number | null;
}

export class CampaignMemberRoleDto {
    @ApiProperty({ enum: ['MASTER', 'PLAYER'] })
    role!: 'MASTER' | 'PLAYER';
}

export class CampaignSettingsDto {
    @ApiProperty() id!: number;
    @ApiProperty() name!: string;
    @ApiProperty({ nullable: true, enum: SUPPORTED_LOCALES, description: 'Spoken language: drives transcription and summaries.' })
    language!: string | null;
    @ApiProperty({ nullable: true }) current_year!: number | null;
    @ApiProperty({ nullable: true, description: 'Name of the party faction.' })
    party_name!: string | null;
    @ApiProperty({ description: 'Whether the AI may update character sheets on its own.' })
    allow_auto_character_update!: boolean;
    @ApiProperty({
        nullable: true,
        description: 'How this table\'s generated pictures should look. Null keeps the built-in painterly style.',
    })
    art_direction!: string | null;
}

export class CampaignSettingsPatchDto {
    @ApiProperty({ required: false, maxLength: 80 }) name?: string;
    @ApiProperty({ required: false, enum: SUPPORTED_LOCALES, nullable: true }) language?: string | null;
    @ApiProperty({ required: false, nullable: true }) current_year?: number | null;
    @ApiProperty({ required: false, maxLength: 80 }) party_name?: string;
    @ApiProperty({ required: false }) allow_auto_character_update?: boolean;
    @ApiProperty({ required: false, nullable: true, maxLength: 400 }) art_direction?: string | null;
}

export class CreateCampaignDto {
    @ApiProperty({ maxLength: 80 }) name!: string;
    @ApiProperty({ required: false, enum: SUPPORTED_LOCALES, description: 'Spoken language of the table.' })
    language?: string;
    @ApiProperty({ required: false, description: 'In-world year the campaign starts from.' })
    current_year?: number;
    @ApiProperty({ required: false, maxLength: 80, description: 'Name of the party faction.' })
    party_name?: string;
}

export class CharacterSheetDto {
    @ApiProperty() user_id!: string;
    @ApiProperty({ nullable: true }) character_name!: string | null;
    @ApiProperty({ nullable: true }) race!: string | null;
    @ApiProperty({ nullable: true }) class!: string | null;
    @ApiProperty({ nullable: true, description: 'Biography shown in the app: AI-generated unless written by hand.' })
    description!: string | null;
    @ApiProperty({ description: 'True when the sheet is hand-written and protected from AI rewrites.' })
    is_manual!: boolean;
}

export class CharacterSheetPatchDto {
    @ApiProperty({ required: false, maxLength: 80 }) character_name?: string;
    @ApiProperty({ required: false, maxLength: 80 }) race?: string;
    @ApiProperty({ required: false, maxLength: 80 }) class?: string;
    @ApiProperty({
        required: false,
        maxLength: 4000,
        description: 'Hand-written biography. Setting it marks the sheet manual and shields it from AI rewrites.',
    })
    description?: string;
}

export class BioRegenEstimateDto {
    @ApiProperty({
        enum: ['READY', 'NO_HISTORY'],
        description: 'NO_HISTORY means there is nothing to regenerate from: no AI call is made.',
    })
    status!: 'READY' | 'NO_HISTORY';
    @ApiProperty() will_invoke_ai!: boolean;
    @ApiProperty({ description: "Provider that will run it, on the user's own account (BYOK)." })
    provider!: string;
    @ApiProperty() model!: string;
}

/**
 * The answer to "rewrite this biography".
 *
 * A job id rather than the new text: the rewrite happens outside the request.
 * `job_id` is null when there was no history to rewrite from — nothing started,
 * nothing spent.
 */
export class BioRegenStartDto {
    @ApiProperty({ nullable: true }) job_id!: string | null;
    @ApiProperty({ description: 'False when there was nothing to rewrite.' })
    invoked_ai!: boolean;
}

export class BioRegenResultDto {
    @ApiProperty({ type: CharacterSheetDto }) character!: CharacterSheetDto;
    @ApiProperty() invoked_ai!: boolean;
    @ApiProperty({ nullable: true }) cost_usd!: number | null;
    @ApiProperty({ nullable: true }) cost_eur!: number | null;
}
