import { ApiProperty } from '@nestjs/swagger';
import { Paginated } from '../../common/pagination';

export class AskEstimateDto {
    @ApiProperty({ description: 'Provider that will answer, on the user\'s own account (BYOK).' })
    provider!: string;

    @ApiProperty({ description: 'Model that will answer.' })
    model!: string;
}

export class AskMessageDto {
    @ApiProperty() id!: number;
    @ApiProperty({ enum: ['user', 'assistant'] }) role!: 'user' | 'assistant';
    @ApiProperty() content!: string;
    @ApiProperty() created_at!: number;
    @ApiProperty({ nullable: true }) cost_usd!: number | null;
    @ApiProperty({ nullable: true }) cost_eur!: number | null;
    @ApiProperty({ nullable: true }) provider!: string | null;
    @ApiProperty({ nullable: true }) model!: string | null;
}

export class AskConversationDto {
    @ApiProperty() id!: number;
    @ApiProperty({ description: 'Derived from the first question, renameable.' }) title!: string;
    @ApiProperty({ description: 'Published read-only to the rest of the table.' }) shared!: boolean;
    @ApiProperty({ description: 'False when another member shared it with you.' }) owned!: boolean;
    @ApiProperty() created_at!: number;
    @ApiProperty() updated_at!: number;
    @ApiProperty() message_count!: number;
}

export class AskConversationDetailDto extends AskConversationDto {
    @ApiProperty({ type: [AskMessageDto] })
    messages!: AskMessageDto[];
}

export class PaginatedAskConversationDto extends Paginated(AskConversationDto) {}

export class AskAnswerDto {
    @ApiProperty({ type: AskConversationDto })
    conversation!: AskConversationDto;

    @ApiProperty({ type: AskMessageDto, description: 'The Bard answer that was just persisted.' })
    message!: AskMessageDto;

    /**
     * Whether the Bard held the whole answer in the campaign's records.
     *
     * Not persisted with the message: it belongs to the moment of answering, and
     * the substance of a refusal is in the answer text itself, which is stored.
     * Null means the model did not declare either way — shown as nothing, never
     * as a reassurance nobody gave.
     */
    @ApiProperty({ nullable: true })
    grounded!: boolean | null;

    /** What the question asked for and the records do not contain. */
    @ApiProperty({ isArray: true, type: String })
    missing!: string[];
}

export class AskQuestionBodyDto {
    @ApiProperty({ description: 'The question for the Bard.', maxLength: 2000 })
    question!: string;
}

export class AskConversationPatchDto {
    @ApiProperty({ required: false, description: 'New title. Empty or whitespace-only is rejected.' })
    title?: string;

    @ApiProperty({ required: false, description: 'Publish or withdraw the conversation for the rest of the table.' })
    shared?: boolean;
}
