import { db } from '../client';
import type { AIProvider } from '../../config';
import type { AiTier } from '../../bard/ai/types';

/**
 * The models offered in the settings selects.
 *
 * A **cache with a refresh date**, not a source of truth: `replaceAll` swaps the
 * whole content in one transaction, and an empty table is a legitimate state —
 * the curated list committed in `bard/ai/modelCatalog.ts` answers in its place.
 * Nothing here may ever be the only copy of anything.
 *
 * The price fields are nullable **and null means "we do not know"**, never zero:
 * it is the same distinction `services/pricingSource.ts` exists to protect, and
 * a model whose rate we failed to learn must reach the UI as a missing figure
 * rather than as a free one.
 */

export type ModelKind = 'text' | 'transcription' | 'image';

export interface CatalogRecord {
    provider: AIProvider;
    modelId: string;
    kind: ModelKind;
    label: string | null;
    tiers: AiTier[];
    recommendedFor: AiTier[];
    /** USD per 1M tokens. `null` when unknown — not 0. */
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    cachedInputPerMillion: number | null;
    /** USD per minute of audio, transcription only. `null` when unknown. */
    perMinuteUsd: number | null;
    /** USD per generated image, image models only. `null` when unknown. */
    perImageUsd: number | null;
    contextTokens: number | null;
    maxOutputTokens: number | null;
    releaseDate: string | null;
    source: string;
    refreshedAt: number;
}

interface CatalogRow {
    provider: AIProvider;
    model_id: string;
    kind: ModelKind;
    label: string | null;
    tiers: string;
    recommended_for: string;
    input_per_million: number | null;
    output_per_million: number | null;
    cached_input_per_million: number | null;
    per_minute_usd: number | null;
    per_image_usd: number | null;
    context_tokens: number | null;
    max_output_tokens: number | null;
    release_date: string | null;
    source: string;
    refreshed_at: number;
}

/** A malformed JSON column degrades to an empty list, never throws. */
function parseTiers(raw: string): AiTier[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as AiTier[] : [];
    } catch {
        return [];
    }
}

function toRecord(row: CatalogRow): CatalogRecord {
    return {
        provider: row.provider,
        modelId: row.model_id,
        kind: row.kind,
        label: row.label,
        tiers: parseTiers(row.tiers),
        recommendedFor: parseTiers(row.recommended_for),
        inputPerMillion: row.input_per_million,
        outputPerMillion: row.output_per_million,
        cachedInputPerMillion: row.cached_input_per_million,
        perMinuteUsd: row.per_minute_usd,
        perImageUsd: row.per_image_usd,
        contextTokens: row.context_tokens,
        maxOutputTokens: row.max_output_tokens,
        releaseDate: row.release_date,
        source: row.source,
        refreshedAt: row.refreshed_at,
    };
}

/**
 * A catalogue that cannot be read is an empty catalogue.
 *
 * This is on the hot path of every cost calculation, and the table may
 * legitimately not be there yet — a process that reads before `initDatabase()`,
 * a test that only needs the price list. Throwing would turn a missing cache
 * into a failed AI call, which is the wrong trade by a wide margin: the curated
 * list is right behind, and it answers.
 */
function safely<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch (error) {
        const message = (error as { message?: string }).message ?? '';
        if (!message.includes('no such table')) {
            console.warn('[ModelCatalog] Catalogue unreadable, falling back to the curated list.', error);
        }
        return fallback;
    }
}

export const modelCatalogRepository = {
    /** Every model of a kind, cheapest first — the order the selects present. */
    list(kind: ModelKind, provider?: AIProvider): CatalogRecord[] {
        return safely(() => {
            const rows = provider
                ? db.prepare(
                    `SELECT * FROM model_catalog WHERE kind = ? AND provider = ?
                     ORDER BY COALESCE(input_per_million, per_minute_usd, per_image_usd, 0), model_id`,
                ).all(kind, provider) as CatalogRow[]
                : db.prepare(
                    `SELECT * FROM model_catalog WHERE kind = ?
                     ORDER BY provider, COALESCE(input_per_million, per_minute_usd, per_image_usd, 0), model_id`,
                ).all(kind) as CatalogRow[];
            return rows.map(toRecord);
        }, []);
    },

    /**
     * Swaps the whole catalogue.
     *
     * In a transaction and by replacement rather than upsert: a model withdrawn
     * by its provider has to **disappear**, otherwise the select keeps offering
     * it forever and the choice fails only at the first session. A partially
     * written catalogue would be worse than the previous one, hence the
     * all-or-nothing.
     */
    replaceAll(records: CatalogRecord[]): void {
        const wipe = db.prepare('DELETE FROM model_catalog');
        const insert = db.prepare(`
            INSERT INTO model_catalog (
                provider, model_id, kind, label, tiers, recommended_for,
                input_per_million, output_per_million, cached_input_per_million,
                per_minute_usd, per_image_usd, context_tokens, max_output_tokens,
                release_date, source, refreshed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        db.transaction((entries: CatalogRecord[]) => {
            wipe.run();
            for (const entry of entries) {
                insert.run(
                    entry.provider, entry.modelId, entry.kind, entry.label,
                    JSON.stringify(entry.tiers), JSON.stringify(entry.recommendedFor),
                    entry.inputPerMillion, entry.outputPerMillion, entry.cachedInputPerMillion,
                    entry.perMinuteUsd, entry.perImageUsd, entry.contextTokens, entry.maxOutputTokens,
                    entry.releaseDate, entry.source, entry.refreshedAt,
                );
            }
        })(records);
    },

    /** When the catalogue was last rebuilt, or `null` if it never was. */
    refreshedAt(): number | null {
        return safely(() => {
            const row = db.prepare(
                'SELECT MAX(refreshed_at) AS refreshed_at FROM model_catalog',
            ).get() as { refreshed_at: number | null } | undefined;
            return row?.refreshed_at ?? null;
        }, null);
    },

    /** True when there is nothing to serve and the builtin list must answer. */
    isEmpty(): boolean {
        return safely(() => {
            const row = db.prepare('SELECT COUNT(*) AS n FROM model_catalog').get() as { n: number };
            return row.n === 0;
        }, true);
    },
};
