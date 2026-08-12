import { ApiProperty } from '@nestjs/swagger';
import { INVENTORY_CATEGORIES, InventoryCategory } from '../../../db/types';
import { EntityImageDto } from './media.dto';

export class SessionNavigationItemDto {
    @ApiProperty() session_id!: string;
    @ApiProperty() start_time!: number;
    @ApiProperty({ nullable: true, type: Number }) session_number!: number | null;
    @ApiProperty({ nullable: true, type: String }) title!: string | null;
}

export class SessionNavigationDto {
    @ApiProperty({ type: SessionNavigationItemDto, nullable: true })
    previous!: SessionNavigationItemDto | null;

    @ApiProperty({ type: SessionNavigationItemDto, nullable: true })
    next!: SessionNavigationItemDto | null;
}

export class SessionParticipantDto {
    @ApiProperty() userId!: string;
    @ApiProperty({ nullable: true, type: String }) characterName!: string | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class SessionMediaDto {
    @ApiProperty() audioAvailable!: boolean;
    @ApiProperty() transcriptAvailable!: boolean;
}

export class SessionSummaryMetadataDto {
    @ApiProperty() title!: string;
    @ApiProperty() tone!: string;
    @ApiProperty() tokens!: number;
    @ApiProperty({ description: 'Epoch milliseconds.' }) generatedAt!: number;
    @ApiProperty() acts!: number;
}

export class SessionNoteDto {
    @ApiProperty() id!: number;
    @ApiProperty() session_id!: string;
    @ApiProperty({ nullable: true, type: String }) user_id!: string | null;
    @ApiProperty() content!: string;
    @ApiProperty({ nullable: true, type: Number }) timestamp!: number | null;
    @ApiProperty({ nullable: true, type: Number }) created_at!: number | null;
    @ApiProperty({ nullable: true, type: String }) macro_location!: string | null;
    @ApiProperty({ nullable: true, type: String }) micro_location!: string | null;
}

export class SessionNpcDto {
    @ApiProperty({ nullable: true, type: String }) short_id!: string | null;
    @ApiProperty() name!: string;
    @ApiProperty({ nullable: true, type: String }) role!: string | null;
    @ApiProperty() status!: string;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class SessionQuestDto {
    @ApiProperty({ nullable: true, type: String }) short_id!: string | null;
    @ApiProperty() title!: string;
    @ApiProperty() status!: string;
}

export class SessionInventoryDto {
    @ApiProperty({ nullable: true, type: String }) short_id!: string | null;
    @ApiProperty() item_name!: string;
    @ApiProperty() quantity!: number;
    @ApiProperty({ enum: INVENTORY_CATEGORIES, enumName: 'InventoryCategory' })
    category!: InventoryCategory;
    @ApiProperty({ type: EntityImageDto, nullable: true, description: 'Image of the linked artifact, when present.' })
    image!: EntityImageDto | null;
}

export class SessionBestiaryDto {
    @ApiProperty({ nullable: true, type: String }) short_id!: string | null;
    @ApiProperty() name!: string;
    @ApiProperty() status!: string;
}

export class SessionTravelDto {
    @ApiProperty() macro_location!: string;
    @ApiProperty() micro_location!: string;
    @ApiProperty() timestamp!: number;
}

export class SessionDetailDto {
    @ApiProperty() session_id!: string;
    @ApiProperty() start_time!: number;
    @ApiProperty() fragments!: number;
    @ApiProperty({ nullable: true, type: String }) campaign_name!: string | null;
    @ApiProperty() campaign_id!: number;
    @ApiProperty({ nullable: true, type: Number }) session_number!: number | null;
    @ApiProperty({ nullable: true, type: String }) title!: string | null;
    @ApiProperty({ nullable: true, type: String }) brief!: string | null;
    @ApiProperty({ nullable: true, type: String }) narrative!: string | null;
    @ApiProperty({ type: SessionSummaryMetadataDto, nullable: true })
    metadata!: SessionSummaryMetadataDto | null;
    @ApiProperty({ type: [SessionNoteDto] }) notes!: SessionNoteDto[];
    @ApiProperty({ type: [SessionNpcDto] }) npcsEncountered!: SessionNpcDto[];
    @ApiProperty({ type: [SessionQuestDto] }) quests!: SessionQuestDto[];
    @ApiProperty({ type: [SessionInventoryDto] }) inventory!: SessionInventoryDto[];
    @ApiProperty({ type: [SessionBestiaryDto] }) bestiary!: SessionBestiaryDto[];
    @ApiProperty({ type: [SessionTravelDto] }) travels!: SessionTravelDto[];
    @ApiProperty({ type: SessionNavigationDto }) navigation!: SessionNavigationDto;
    @ApiProperty({ type: [SessionParticipantDto] }) participants!: SessionParticipantDto[];
    @ApiProperty({ type: SessionMediaDto }) media!: SessionMediaDto;
}

export class SessionTranscriptEntryDto {
    @ApiProperty() text!: string;
    @ApiProperty({ nullable: true, type: String }) userId!: string | null;
    @ApiProperty({ nullable: true, type: String }) characterName!: string | null;
    @ApiProperty() timestamp!: number;
    @ApiProperty({ nullable: true, type: String }) macroLocation!: string | null;
    @ApiProperty({ nullable: true, type: String }) microLocation!: string | null;
}

export class SessionTranscriptDto {
    @ApiProperty({ type: [SessionTranscriptEntryDto] })
    items!: SessionTranscriptEntryDto[];
}
