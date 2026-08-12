/**
 * Response DTOs for the entity list endpoints.
 *
 * Each one is paired with a column whitelist in ./projections.ts. The mapper
 * takes the repository's own row type, so `pick` fails to compile if a
 * projection names a column that table does not have — which is the class of
 * mistake this layer exists to prevent.
 *
 * Alignment is stored twice on the entities that have it: a *chosen* 9-cell
 * label pair (alignment_moral/alignment_ethical) and a *computed* spectrum from
 * event weights (moral_score/ethical_score). Both are surfaced as enum keys,
 * never as translated strings — the ±25 thresholds live in
 * src/utils/alignmentUtils.ts and must not be re-derived by clients.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Paginated } from '../../common/pagination';
import {
    ArtifactEntry,
    AtlasEntryFull,
    BestiaryEntry,
    FactionEntry,
    InventoryItem,
    INVENTORY_CATEGORIES,
    InventoryCategory,
    NpcEntry,
    Quest,
    QUEST_LIFECYCLE_ACTIONS,
    QUEST_LIFECYCLE_CONFIDENCES,
    QUEST_LIFECYCLE_SUGGESTION_STATUSES,
    QUEST_STATUSES,
    QUEST_TYPES,
    QuestLifecycleAction,
    QuestLifecycleConfidence,
    QuestLifecycleSuggestionStatus,
    QuestStatus,
    QuestType,
    UserProfile,
    WorldHistoryEntry,
} from '../../../db/types';
import {
    ARTIFACT_FIELDS,
    BESTIARY_FIELDS,
    CHARACTER_FIELDS,
    FACTION_FIELDS,
    INVENTORY_FIELDS,
    LOCATION_FIELDS,
    NPC_FIELDS,
    QUEST_FIELDS,
    TIMELINE_FIELDS,
    pick,
} from './projections';
import { EntityImageDto } from './media.dto';

const SHORT_ID = { description: '5-char campaign-scoped identifier used in URLs.' };

export class NpcListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty() name!: string;
    @ApiProperty({ nullable: true }) role!: string | null;
    @ApiProperty({ nullable: true }) status!: string | null;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty({ nullable: true }) aliases!: string | null;
    @ApiProperty({ nullable: true, description: 'Chosen moral alignment key, e.g. GOOD.' })
    alignment_moral!: string | null;
    @ApiProperty({ nullable: true, description: 'Chosen ethical alignment key, e.g. LAWFUL.' })
    alignment_ethical!: string | null;
    @ApiProperty({ nullable: true, description: 'Computed moral spectrum, -100..100.' })
    moral_score!: number | null;
    @ApiProperty({ nullable: true, description: 'Computed ethical spectrum, -100..100.' })
    ethical_score!: number | null;
    @ApiProperty({ nullable: true }) last_updated!: string | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class LocationListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty() macro_location!: string;
    @ApiProperty() micro_location!: string;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty({ nullable: true }) last_updated!: string | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class FactionListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty() name!: string;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty({ description: 'PARTY | GUILD | KINGDOM | CULT | ORGANIZATION | GENERIC' })
    type!: string;
    @ApiProperty({ description: 'ACTIVE | DISBANDED | DESTROYED' }) status!: string;
    @ApiProperty({ description: '1 for the party faction itself (see getPartyFaction).' })
    is_party!: number;
    @ApiProperty({ nullable: true }) alignment_moral!: string | null;
    @ApiProperty({ nullable: true }) alignment_ethical!: string | null;
    @ApiProperty({ nullable: true }) moral_score!: number | null;
    @ApiProperty({ nullable: true }) ethical_score!: number | null;
    @ApiProperty({ nullable: true }) last_updated!: string | null;
    @ApiProperty({
        description: "The party's standing toward this faction; NEUTRAL when nothing has been recorded.",
        example: 'CORDIAL',
    })
    reputation!: string;
}

export class QuestListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty() title!: string;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty({ enum: QUEST_STATUSES, enumName: 'QuestStatus' }) status!: QuestStatus;
    @ApiProperty({ enum: QUEST_TYPES, enumName: 'QuestType' }) type!: QuestType;
    @ApiProperty({ nullable: true, description: 'Session that introduced the quest.' })
    session_id!: string | null;
    @ApiProperty({ nullable: true }) last_updated!: number | null;
}

export class QuestMutationDto {
    @ApiProperty() title!: string;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty({ enum: QUEST_STATUSES, enumName: 'QuestStatus' }) status!: QuestStatus;
    @ApiProperty({ enum: QUEST_TYPES, enumName: 'QuestType' }) type!: QuestType;
}

export class QuestLifecycleSuggestionDto {
    @ApiProperty() id!: number;
    @ApiProperty() campaign_id!: number;
    @ApiProperty({ nullable: true }) quest_id!: number | null;
    @ApiProperty({ nullable: true }) session_id!: string | null;
    @ApiProperty({ enum: QUEST_LIFECYCLE_ACTIONS }) proposed_action!: QuestLifecycleAction;
    @ApiProperty() proposed_title!: string;
    @ApiProperty({ nullable: true }) proposed_description!: string | null;
    @ApiProperty({ enum: QUEST_STATUSES }) proposed_status!: QuestStatus;
    @ApiProperty({ enum: QUEST_TYPES }) proposed_type!: QuestType;
    @ApiProperty() evidence!: string;
    @ApiProperty({ enum: QUEST_LIFECYCLE_CONFIDENCES }) confidence!: QuestLifecycleConfidence;
    @ApiProperty({ enum: QUEST_LIFECYCLE_SUGGESTION_STATUSES }) status!: QuestLifecycleSuggestionStatus;
    @ApiProperty() created_at!: number;
    @ApiProperty({ nullable: true }) resolved_at!: number | null;
}

export class AiTokenRangeDto {
    @ApiProperty() input_min!: number;
    @ApiProperty() input_max!: number;
    @ApiProperty() output_min!: number;
    @ApiProperty() output_max!: number;
}

export class AiMoneyRangeDto {
    @ApiProperty() min!: number;
    @ApiProperty() max!: number;
}

export class AiExchangeRateDto {
    @ApiProperty({ enum: ['ECB', 'STALE_ECB', 'UNAVAILABLE'] })
    source!: 'ECB' | 'STALE_ECB' | 'UNAVAILABLE';
    @ApiProperty({ nullable: true, description: 'USD quoted by ECB for one EUR.' })
    usd_per_eur!: number | null;
    @ApiProperty({ nullable: true, description: 'ECB reference-rate date (YYYY-MM-DD).' })
    rate_date!: string | null;
    @ApiProperty({ nullable: true, description: 'Epoch milliseconds when the rate was fetched.' })
    fetched_at!: number | null;
}

export class QuestAuditEstimateDto {
    @ApiProperty({ enum: ['READY', 'RUNNING', 'COOLDOWN', 'NO_SESSIONS', 'NOTHING_TO_AUDIT'] })
    status!: 'READY' | 'RUNNING' | 'COOLDOWN' | 'NO_SESSIONS' | 'NOTHING_TO_AUDIT';
    @ApiProperty() will_invoke_ai!: boolean;
    @ApiProperty() billable!: boolean;
    @ApiProperty() pricing_available!: boolean;
    @ApiProperty() provider!: string;
    @ApiProperty() model!: string;
    @ApiProperty() session_count!: number;
    @ApiProperty() open_quest_count!: number;
    @ApiProperty() pending_suggestion_count!: number;
    @ApiProperty({ type: AiTokenRangeDto, nullable: true })
    estimated_tokens!: AiTokenRangeDto | null;
    @ApiProperty({ type: AiMoneyRangeDto, nullable: true })
    estimated_cost_usd!: AiMoneyRangeDto | null;
    @ApiProperty({ type: AiMoneyRangeDto, nullable: true })
    estimated_cost_eur!: AiMoneyRangeDto | null;
    @ApiProperty({ type: AiExchangeRateDto })
    exchange_rate!: AiExchangeRateDto;
    @ApiProperty({ nullable: true })
    cooldown_ends_at!: number | null;
}

export class AiUsageResultDto {
    @ApiProperty() provider!: string;
    @ApiProperty() model!: string;
    @ApiProperty() input_tokens!: number;
    @ApiProperty() output_tokens!: number;
    @ApiProperty() cached_input_tokens!: number;
    @ApiProperty() billable!: boolean;
    @ApiProperty() pricing_available!: boolean;
    @ApiProperty({ nullable: true }) cost_usd!: number | null;
    @ApiProperty({ nullable: true }) cost_eur!: number | null;
    @ApiProperty({ type: AiExchangeRateDto }) exchange_rate!: AiExchangeRateDto;
}

/**
 * The answer to "start an audit".
 *
 * It carries a job id rather than the result, because the run outlives the
 * request that asked for it. `job_id` is null when the audit was not worth
 * starting — nothing open to audit, or too soon since the last one — which is an
 * answer and not a failure, and costs nothing either way.
 */
export class QuestAuditStartDto {
    @ApiProperty({ nullable: true }) job_id!: string | null;
    @ApiProperty({ description: 'False when nothing was started, and nothing will be spent.' })
    invoked_ai!: boolean;
    @ApiProperty({ enum: ['COOLDOWN', 'NOTHING_TO_AUDIT'], nullable: true })
    skipped_reason!: 'COOLDOWN' | 'NOTHING_TO_AUDIT' | null;
}

export class QuestLifecycleAuditResultDto {
    @ApiProperty({ type: [QuestLifecycleSuggestionDto] })
    suggestions!: QuestLifecycleSuggestionDto[];
    @ApiProperty({ type: AiUsageResultDto, nullable: true })
    usage!: AiUsageResultDto | null;
    @ApiProperty({ description: 'False when the cooldown returned existing suggestions without an AI call.' })
    invoked_ai!: boolean;
    @ApiProperty({ enum: ['COOLDOWN', 'NOTHING_TO_AUDIT'], nullable: true })
    skipped_reason!: 'COOLDOWN' | 'NOTHING_TO_AUDIT' | null;
}

export class InventoryListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty() item_name!: string;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty() quantity!: number;
    @ApiProperty({ enum: INVENTORY_CATEGORIES, enumName: 'InventoryCategory' })
    category!: InventoryCategory;
    @ApiProperty({ nullable: true }) notes!: string | null;
    @ApiProperty({ nullable: true }) last_updated!: number | null;
    @ApiProperty({ description: 'Joined from artifacts: the item is also a tracked artifact.' })
    is_artifact!: boolean;
    @ApiProperty({ nullable: true, description: 'short_id of the matching artifact, for linking.' })
    artifact_short_id!: string | null;
    @ApiProperty({ nullable: true }) artifact_status!: string | null;
    @ApiProperty({ nullable: true }) is_cursed!: boolean | null;
    @ApiProperty({ type: EntityImageDto, nullable: true, description: 'Image of the linked artifact, when present.' })
    image!: EntityImageDto | null;
}

export class InventoryDetailDto extends InventoryListDto {
    @ApiProperty({ nullable: true, description: 'Epoch milliseconds when the item was acquired.' })
    acquired_at!: number | null;

    @ApiProperty({ nullable: true, description: 'Session that most recently introduced or changed the item.' })
    session_id!: string | null;
}

export class UpdateInventoryCategoryDto {
    @ApiProperty({ enum: INVENTORY_CATEGORIES, enumName: 'InventoryCategory' })
    category!: InventoryCategory;
}

export class ArtifactListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty() name!: string;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty({ nullable: true }) effects!: string | null;
    @ApiProperty({ description: 'FUNCTIONAL | DESTROYED | LOST | SEALED | DORMANT' }) status!: string;
    @ApiProperty() is_cursed!: number;
    @ApiProperty({ nullable: true }) curse_description!: string | null;
    @ApiProperty({ nullable: true, description: 'PC | NPC | FACTION | LOCATION | NONE' })
    owner_type!: string | null;
    @ApiProperty({ nullable: true }) owner_id!: number | null;
    @ApiProperty({ nullable: true }) owner_name!: string | null;
    @ApiProperty({ nullable: true }) location_macro!: string | null;
    @ApiProperty({ nullable: true }) location_micro!: string | null;
    @ApiProperty({ nullable: true }) faction_id!: number | null;
    @ApiProperty({ nullable: true }) last_updated!: string | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class BestiaryListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty() name!: string;
    @ApiProperty({ nullable: true }) description!: string | null;
    @ApiProperty() status!: string;
    @ApiProperty({ type: [String], description: 'Parsed from a JSON-encoded TEXT column.' })
    abilities!: string[];
    @ApiProperty({ type: [String] }) weaknesses!: string[];
    @ApiProperty({ type: [String] }) resistances!: string[];
    @ApiProperty({ type: [String] }) variants!: string[];
    @ApiProperty({ nullable: true }) notes!: string | null;
    @ApiProperty({ nullable: true }) last_seen!: number | null;
}

/** Characters have no short_id (see the web app's data map) — keyed by Discord user id. */
export class CharacterListDto {
    @ApiProperty({ description: 'Discord user id; the identifier used in URLs.' })
    user_id!: string;
    @ApiProperty({ nullable: true }) character_name!: string | null;
    @ApiProperty({ nullable: true }) race!: string | null;
    @ApiProperty({ nullable: true }) class!: string | null;
    @ApiProperty({ nullable: true, description: 'AI-generated bio.' })
    description!: string | null;
    @ApiProperty({ nullable: true, description: 'Player-authored background.' })
    foundation_description!: string | null;
    @ApiProperty({ nullable: true }) alignment_moral!: string | null;
    @ApiProperty({ nullable: true }) alignment_ethical!: string | null;
    @ApiProperty({ nullable: true }) moral_score!: number | null;
    @ApiProperty({ nullable: true }) ethical_score!: number | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class TimelineListDto {
    @ApiProperty(SHORT_ID) short_id!: string;
    @ApiProperty({ nullable: true, description: 'In-world year.' }) year!: number | null;
    @ApiProperty({ description: 'WAR | POLITICS | DISCOVERY | CALAMITY | SUPERNATURAL | GENERIC' })
    event_type!: string;
    @ApiProperty() description!: string;
    @ApiProperty({ nullable: true }) session_id!: string | null;
    @ApiProperty({ nullable: true }) timestamp!: number | null;
}

export class PaginatedNpcListDto extends Paginated(NpcListDto) {}
export class PaginatedLocationListDto extends Paginated(LocationListDto) {}
export class PaginatedFactionListDto extends Paginated(FactionListDto) {}
export class PaginatedQuestListDto extends Paginated(QuestListDto) {}
export class PaginatedInventoryListDto extends Paginated(InventoryListDto) {}
export class PaginatedArtifactListDto extends Paginated(ArtifactListDto) {}
export class PaginatedBestiaryListDto extends Paginated(BestiaryListDto) {}
export class PaginatedTimelineListDto extends Paginated(TimelineListDto) {}
export class PaginatedCharacterListDto extends Paginated(CharacterListDto) {}

/** Malformed JSON must degrade to an empty list, never 500 a whole page. */
function parseJsonArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

type InventoryRow = InventoryItem & {
    is_artifact: boolean;
    artifact_status: string | null;
    artifact_short_id: string | null;
    is_cursed: boolean | null;
};

export function toNpcListDto(row: NpcEntry, image: EntityImageDto | null = null): NpcListDto {
    return { ...(pick(row, NPC_FIELDS) as unknown as NpcListDto), image };
}

export function toLocationListDto(row: AtlasEntryFull, image: EntityImageDto | null = null): LocationListDto {
    return { ...(pick(row, LOCATION_FIELDS) as unknown as LocationListDto), image };
}

/** `reputation` is joined on, not a factions column, so it is carried alongside the projection. */
export function toFactionListDto(row: FactionEntry & { reputation?: string }): FactionListDto {
    return {
        ...(pick(row, FACTION_FIELDS) as unknown as FactionListDto),
        reputation: row.reputation ?? 'NEUTRAL',
    };
}

export function toQuestListDto(row: Quest): QuestListDto {
    return pick(row, QUEST_FIELDS) as unknown as QuestListDto;
}

export function toInventoryListDto(row: InventoryRow, image: EntityImageDto | null = null): InventoryListDto {
    return { ...(pick(row, INVENTORY_FIELDS) as unknown as InventoryListDto), image };
}

export function toInventoryDetailDto(row: InventoryRow, image: EntityImageDto | null = null): InventoryDetailDto {
    return {
        ...toInventoryListDto(row, image),
        acquired_at: row.acquired_at ?? null,
        session_id: row.session_id ?? null,
    };
}

export function toArtifactListDto(row: ArtifactEntry, image: EntityImageDto | null = null): ArtifactListDto {
    return { ...(pick(row, ARTIFACT_FIELDS) as unknown as ArtifactListDto), image };
}

export function toBestiaryListDto(row: BestiaryEntry): BestiaryListDto {
    return {
        ...(pick(row, BESTIARY_FIELDS) as unknown as BestiaryListDto),
        abilities: parseJsonArray(row.abilities),
        weaknesses: parseJsonArray(row.weaknesses),
        resistances: parseJsonArray(row.resistances),
        variants: parseJsonArray(row.variants),
    };
}

export function toTimelineListDto(row: WorldHistoryEntry): TimelineListDto {
    return pick(row, TIMELINE_FIELDS) as unknown as TimelineListDto;
}

export function toCharacterListDto(
    row: UserProfile & { user_id: string; foundation_description: string | null },
    image: EntityImageDto | null = null,
): CharacterListDto {
    return { ...(pick(row, CHARACTER_FIELDS) as unknown as CharacterListDto), image };
}
