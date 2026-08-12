import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Public merge capability.
 *
 * Adding a type here and in the `merge-entity.registry.ts` registry enables the
 * same HTTP contract and the same wizard, without creating ad-hoc endpoints.
 */
export const MERGEABLE_ENTITY_TYPES = ['artifacts', 'npcs', 'factions'] as const;
export type MergeableEntityType = typeof MERGEABLE_ENTITY_TYPES[number];

/** Membro di un cluster di duplicati (output di GET /duplicates). */
export class DuplicateMemberDto {
    @ApiProperty({ description: 'Stable short id of the entity.' })
    short_id!: string;

    @ApiProperty()
    name!: string;

    @ApiProperty({ description: "0/1 — se l'entità è bloccata manuale (ha priorità come survivor)." })
    is_manual!: number;

    @ApiProperty({ description: 'How many history events are attached.' })
    history_count!: number;

    @ApiProperty({ description: 'True when a RAG *_UPDATE card exists for this entity.' })
    has_rag!: boolean;

    @ApiProperty({ nullable: true, description: 'Descrizione/bio attuale (anteprima).' })
    description!: string | null;

    @ApiProperty({ description: 'Similarity score against the suggested survivor (0..1).' })
    score!: number;

    @ApiProperty({ description: 'Why they matched (the reconciliation reason).' })
    reason!: string;
}

/** A cluster of duplicates with the suggested survivor. */
export class DuplicateClusterDto {
    @ApiProperty({ description: 'Stable cluster id (a hash of the member short_ids).' })
    id!: string;

    @ApiProperty({ type: DuplicateMemberDto, isArray: true })
    members!: DuplicateMemberDto[];

    @ApiProperty({ description: 'short_id of the suggested survivor.' })
    suggested_survivor!: string;
}

export class DuplicatesResultDto {
    @ApiProperty({ type: DuplicateClusterDto, isArray: true })
    clusters!: DuplicateClusterDto[];
}

/** Body di POST /merge. */
export class MergeRequestDto {
    @ApiProperty({ description: 'short_id of the surviving entity (it absorbs the dropped ones).' })
    keep_short_id!: string;

    @ApiProperty({
        type: String,
        isArray: true,
        description: 'short_ids of the entities to merge into the survivor and delete.',
    })
    drop_short_ids!: string[];

    @ApiPropertyOptional({
        nullable: true,
        description: 'Optional merged description supplied by the user (it overrides).',
    })
    description?: string;

    @ApiPropertyOptional({
        nullable: true,
        description: 'When true, merges the bios through the LLM (smartMergeBios) instead of keeping the survivor\'s.',
    })
    auto_merge_description?: boolean;

    @ApiPropertyOptional({
        nullable: true,
        description: 'Explicit confirmation, required when a dropped entity has is_manual=1.',
    })
    confirm_manual_merge?: boolean;

    @ApiPropertyOptional({
        nullable: true,
        description: 'Desired final name for the survivor. If it differs from the current one the survivor is renamed (RAG headers and history are repointed). Defaults to the survivor name.',
    })
    final_name?: string;
}

export class MergedRowDto {
    @ApiProperty()
    short_id!: string;

    @ApiProperty()
    name!: string;
}

export class RenamedEntityDto {
    @ApiProperty()
    from!: string;

    @ApiProperty()
    to!: string;
}

/** Report of what survived / what died — shown in the FE after the merge. */
export class MergeReportDto {
    @ApiProperty({ type: MergedRowDto, isArray: true, description: 'Righe assorbite e cancellate (i loser).' })
    merged_rows!: { short_id: string; name: string }[];

    @ApiProperty({ description: 'History events repointed onto the survivor.' })
    history_repointed!: number;

    @ApiProperty({ description: 'Snapshot versions folded into the canonical fragment; their content stays in the chronological timeline.' })
    rag_fragments_deleted!: number;

    @ApiProperty({ description: 'Riferimenti RAG riscritti (es. ref inventario, associated_entity_ids).' })
    rag_refs_rewritten!: number;

    @ApiProperty({ description: 'Relazioni DB ripuntate o consolidate (membri, artefatti collegati, ecc.).' })
    relations_repointed!: number;

    @ApiProperty({ description: 'True when the survivor\'s short_id had to be regenerated (a collision).' })
    short_id_regenerated!: boolean;

    @ApiProperty({ description: 'True when is_manual/manual_description was carried over from the loser.' })
    manual_propagated!: boolean;

    @ApiPropertyOptional({ nullable: true, description: 'True when the bios were merged through the LLM.' })
    bio_auto_merged?: boolean;

    @ApiPropertyOptional({
        type: RenamedEntityDto,
        nullable: true,
        description: 'Present when the survivor was renamed (final_name ≠ the current name).',
    })
    renamed?: { from: string; to: string };
}

export class MergeResultDto {
    @ApiProperty({ description: 'short_id of the survivor after the merge (it can change if regenerated).' })
    survivor_short_id!: string;

    @ApiProperty()
    survivor_name!: string;

    @ApiProperty({ type: MergeReportDto })
    report!: MergeReportDto;
}

// --- Preview (diff "what is lost / what remains" before the merge) ---

export class RecordFieldDiffDto {
    @ApiProperty({ description: 'Field name (description, effects, owner_name, status, ...).' })
    field!: string;

    @ApiProperty({ nullable: true })
    survivor_value!: string | null;

    @ApiProperty({ description: 'short_id of the dropped entity the value belongs to.' })
    drop_short_id!: string;

    @ApiProperty()
    drop_name!: string;

    @ApiProperty({ nullable: true })
    drop_value!: string | null;

    @ApiProperty({ description: "kept = the survivor already has the value; discarded = the survivor does not and the dropped entity does (it will be lost without an override); differs = both have one, and the survivor wins." })
    verdict!: 'kept' | 'discarded' | 'differs';
}

export class HistoryEventDto {
    @ApiProperty()
    drop_short_id!: string;

    @ApiProperty()
    drop_name!: string;

    @ApiProperty()
    event_type!: string;

    @ApiProperty({ nullable: true })
    session_date!: string | null;

    @ApiProperty()
    description_preview!: string;
}

export class RagFragmentDto {
    @ApiProperty()
    drop_short_id!: string;

    @ApiProperty()
    drop_name!: string;

    @ApiProperty()
    fragment_id!: number;

    @ApiProperty({ description: 'Card header (a preview).' })
    header!: string;

    @ApiProperty({ description: 'How many chronological versions the row holds (1 for legacy, unconsolidated cards).' })
    version_count!: number;

    @ApiProperty({ description: "consolidated = version absorbed and preserved in the canonical card\'s timeline; deleted = fragment genuinely lost; rewritten = reference repointed; kept = canonical card retained." })
    action!: 'deleted' | 'consolidated' | 'rewritten' | 'kept';
}

export class RelationImpactDto {
    @ApiProperty()
    drop_short_id!: string;

    @ApiProperty()
    drop_name!: string;

    @ApiProperty({ description: 'Relationship family (membership, artifact, ...).' })
    relation_type!: string;

    @ApiProperty({ description: 'Human-readable label of the relationship involved.' })
    label!: string;

    @ApiProperty({ description: 'repointed = moved to the survivor; deduplicated = already present and consolidated.' })
    action!: 'repointed' | 'deduplicated';
}

export class RenamePreviewDto {
    @ApiProperty()
    from!: string;

    @ApiProperty()
    to!: string;
    @ApiProperty({ description: 'The survivor\'s history events that will be repointed to the new name.' })
    history_repointed!: number;
    @ApiProperty({ description: 'The survivor\'s RAG *_UPDATE cards whose header will be rewritten.' })
    rag_headers_rewritten!: number;
}

export class MergePreviewDto {
    @ApiProperty()
    survivor_short_id!: string;

    @ApiProperty()
    survivor_name!: string;

    @ApiProperty({ description: 'The final name chosen (defaults to survivor_name).' })
    final_name!: string;

    @ApiPropertyOptional({ nullable: true, type: RenamePreviewDto })
    rename?: RenamePreviewDto;

    @ApiProperty({ type: RecordFieldDiffDto, isArray: true, description: 'Record field diff: for each dropped entity, which fields will be lost or kept.' })
    record!: RecordFieldDiffDto[];

    @ApiProperty({ type: HistoryEventDto, isArray: true, description: 'History events of the dropped entities that will be repointed onto the survivor.' })
    events!: HistoryEventDto[];

    @ApiProperty({ type: RelationImpactDto, isArray: true, description: 'Relazioni DB preservate, ripuntate o consolidate.' })
    relations!: RelationImpactDto[];

    @ApiProperty({ type: RagFragmentDto, isArray: true, description: 'RAG fragments that will flow into the canonical timeline, stay separate, or have their references rewritten.' })
    rag!: RagFragmentDto[];
}

/** Body di POST .../merge/:entityType/preview (read-only, no mutation). */
export class MergePreviewRequestDto {
    @ApiProperty()
    keep_short_id!: string;

    @ApiProperty({ type: String, isArray: true })
    drop_short_ids!: string[];

    @ApiPropertyOptional({ nullable: true })
    final_name?: string;

    @ApiPropertyOptional({
        nullable: true,
        description: 'Description override, used so the diff computes the final value faithfully.',
    })
    description?: string;
}

/** Body of POST .../merge/:entityType/members: details for the entities selected
 *  manually by the user (no detection). */
export class MergeMembersRequestDto {
    @ApiProperty({ type: String, isArray: true, description: 'short_ids the user selected from the list.' })
    short_ids!: string[];
}
