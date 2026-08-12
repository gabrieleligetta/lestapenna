import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Paginated } from '../../common/pagination';

/**
 * The entity row as it comes out of a create/update: the same shape as the
 * lists, projected through the same whitelist (dto/projections.ts).
 *
 * Flat and not wrapped, so `POST /quests` answers exactly as it did before
 * quest CRUD went through the registry, and whoever creates an entity reads
 * the assigned `short_id` without a second round trip.
 */
export class EntityMutationResultDto {
    @ApiProperty({ description: 'Five-character short id of the row written.' })
    short_id!: string | null;

    [column: string]: unknown;
}

export class EntityDeleteReportDto {
    @ApiProperty({ description: 'Righe di storico rimosse.' })
    history_deleted!: number;

    @ApiProperty({ description: 'Frammenti di memoria RAG rimossi.' })
    rag_fragments_deleted!: number;

    @ApiProperty({ description: 'Riferimenti tipizzati ripuliti dai frammenti superstiti.' })
    rag_refs_stripped!: number;

    @ApiProperty({ description: 'Affiliazioni di fazione rimosse.' })
    affiliations_deleted!: number;

    @ApiProperty({ description: 'True when an uploaded image existed and was removed.' })
    media_deleted!: boolean;
}

export class EntityDeleteResultDto {
    @ApiProperty({ description: 'Human-readable name of the deleted entity.' })
    name!: string;

    @ApiProperty({ type: EntityDeleteReportDto })
    report!: EntityDeleteReportDto;
}

/** Body of a PATCH on a history row. Every field is optional. */
export class EventMutationDto {
    @ApiPropertyOptional({ description: 'The text of the event.' })
    description?: string;

    @ApiPropertyOptional({ description: 'Event type, per domain.' })
    event_type?: string;

    @ApiPropertyOptional({
        description: 'Moral weight (-10..10). Only on NPC/PC/faction history.',
        minimum: -10,
        maximum: 10,
    })
    moral_weight?: number;

    @ApiPropertyOptional({
        description: 'Ethical weight (-10..10). Only on NPC/PC/faction history.',
        minimum: -10,
        maximum: 10,
    })
    ethical_weight?: number;
}

/**
 * A fragment of long-term memory linked to an entity.
 *
 * `embedding` is not exposed: it is a BLOB of floats that tells nothing to
 * someone deciding whether a memory is still relevant.
 */
export class EntityFragmentDto {
    @ApiProperty()
    id!: number;

    @ApiPropertyOptional({
        nullable: true,
        description: 'The originating session, or the card marker (e.g. DOSSIER_UPDATE).',
    })
    session_id!: string | null;

    @ApiProperty({ description: 'First line of the content: the canonical header, when there is one.' })
    header!: string;

    @ApiProperty({ description: 'Full content of the fragment.' })
    content!: string;

    @ApiPropertyOptional({ nullable: true, description: 'Epoch in millisecondi.' })
    created_at!: number | null;

    @ApiPropertyOptional({ nullable: true })
    macro_location!: string | null;

    @ApiPropertyOptional({ nullable: true })
    micro_location!: string | null;

    @ApiProperty({
        description: 'True when this is the entity\'s official card rather than a session memory.',
    })
    is_entity_snapshot!: boolean;
}

export class PaginatedEntityFragmentDto extends Paginated(EntityFragmentDto) {}
