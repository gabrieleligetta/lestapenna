import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Paginated, page, paginateArray, type PaginationParams } from '../../common/pagination';

/**
 * The common shape of every `*_history` row.
 *
 * All eight tables carry these columns plus their own entity name and alignment
 * weights; the API projects to the intersection so one client component can
 * render every entity's history.
 */
export class HistoryEventDto {
    @ApiProperty()
    id!: number;

    @ApiProperty()
    description!: string;

    @ApiProperty()
    event_type!: string;

    @ApiPropertyOptional({ nullable: true })
    session_id!: string | null;

    @ApiPropertyOptional({ nullable: true, description: 'Epoch milliseconds.' })
    timestamp!: number | null;

    @ApiProperty({ description: '1 when a human wrote the event rather than the AI.' })
    is_manual!: number;

    /**
     * This event's contribution to the entity's alignment.
     *
     * It exists only on `npc_history`, `character_history` and `faction_history`:
     * it is the −10..+10 scale that `computeAggregatedAlignmentScore` averages to
     * produce the score the bar shows. Until now neither interface showed it, so
     * the bar looked handed down from above and there was no way to understand —
     * nor to correct — which event had moved it.
     * `null` on the families that do not weight alignment.
     */
    @ApiPropertyOptional({ nullable: true, minimum: -10, maximum: 10 })
    moral_weight!: number | null;

    @ApiPropertyOptional({ nullable: true, minimum: -10, maximum: 10 })
    ethical_weight!: number | null;
}

export class PaginatedHistoryEventDto extends Paginated(HistoryEventDto) {}

/** The row shape the history getters return — a superset of what is exposed. */
interface HistoryRow {
    id?: number;
    description: string;
    event_type: string;
    session_id?: string | null;
    timestamp?: number | null;
    is_manual?: number;
    moral_weight?: number | null;
    ethical_weight?: number | null;
}

/**
 * Sorts, projects and wraps an entity's history.
 *
 * Newest first, matching commands/utils/eventsViewer.ts
 * (`ORDER BY COALESCE(timestamp,0) DESC, id DESC`). The repository getters
 * default to `timestamp ASC` because the RAG summaries and alignment rebuilds
 * read history chronologically, so the order is corrected here rather than by
 * changing a default the bot depends on. Page one used to show the oldest
 * events in an entity's life.
 *
 * Sorting in memory, like paginateArray already does for these same getters: a
 * single entity's history is dozens of rows, and DB-level LIMIT would mean
 * touching eight repository methods that bot commands call.
 */
export function toEventPage(rows: HistoryRow[], pagination: PaginationParams) {
    const sorted = [...rows].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || (b.id ?? 0) - (a.id ?? 0));
    const items = paginateArray(sorted, pagination).map(
        (row): HistoryEventDto => ({
            id: row.id ?? 0,
            description: row.description,
            event_type: row.event_type,
            session_id: row.session_id ?? null,
            timestamp: row.timestamp ?? null,
            is_manual: row.is_manual ?? 0,
            moral_weight: row.moral_weight ?? null,
            ethical_weight: row.ethical_weight ?? null,
        }),
    );
    return page(items, rows.length, pagination);
}
