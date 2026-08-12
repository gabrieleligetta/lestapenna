/** Shared list-endpoint pagination: default 25, max 100 (roadmap 2.4 budget constraint). */

import { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface PaginationParams {
    limit: number;
    offset: number;
}

export function parsePagination(query: { limit?: string; offset?: string }): PaginationParams {
    const limit = Math.min(Math.max(parseInt(query.limit ?? '', 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(parseInt(query.offset ?? '', 10) || 0, 0);
    return { limit, offset };
}

/**
 * For repository methods that return the full array with no DB-level
 * limit/offset (most `*_history` getters) — slices in memory instead of
 * duplicating SQL in the controller. Fine at this dataset size (a single
 * entity's event history), not meant for large top-level lists.
 */
export function paginateArray<T>(rows: T[], { limit, offset }: PaginationParams): T[] {
    return rows.slice(offset, offset + limit);
}

/**
 * The envelope every list endpoint returns. Bare arrays forced the SPA to
 * infer "is there a next page?" from `rows.length < limit`, which cannot
 * render a page count or a "26-50 of 214" footer.
 */
export interface Page<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}

export function page<T>(items: T[], total: number, { limit, offset }: PaginationParams): Page<T> {
    return { items, total, limit, offset };
}

/** Slice in memory and wrap, for repositories that return the whole array. */
export function pageFromArray<T>(rows: T[], params: PaginationParams): Page<T> {
    return page(paginateArray(rows, params), rows.length, params);
}

/**
 * Swagger cannot express a generic `Page<T>`, so each item type gets a named
 * schema built from this mixin — `class PaginatedNpcDto extends Paginated(NpcListDto) {}`.
 * Without the explicit rename every one of them would serialise as "Page".
 */
export function Paginated<T>(ItemDto: Type<T>): Type<Page<T>> {
    class PageOf implements Page<T> {
        @ApiProperty({ type: () => [ItemDto] })
        items!: T[];

        @ApiProperty({ description: 'Total rows matching the query, ignoring limit/offset.' })
        total!: number;

        @ApiProperty()
        limit!: number;

        @ApiProperty()
        offset!: number;
    }
    Object.defineProperty(PageOf, 'name', { value: `Paginated${ItemDto.name}` });
    return PageOf;
}
