import { randomUUID } from 'crypto';
import { db } from '../client';
import type {
    EntityAppearance,
    EntityMediaType,
    EntityPersonality,
    EntityProfileEntry,
    TraitConfidence,
    TraitEvidence,
} from '../types';

/**
 * What the campaign records about how an entity looks and behaves.
 *
 * One row per entity, like its picture. The JSON columns are read back through
 * the helpers at the bottom rather than by the callers: a dossier written by an
 * older version of the extractor must degrade to «nothing recorded» instead of
 * throwing halfway through rendering a sheet.
 *
 * **Ownership is per field, not per record.** A person who types in the eye
 * colour the analysis could not find owns `eyes` and nothing else: a later run
 * fills what they left alone and leaves what they wrote. The alternative —
 * marking the whole dossier manual — punished exactly the behaviour the feature
 * wants, since the person most likely to correct one line is the one with the
 * most to add.
 */

export interface EntityProfileWrite {
    campaign_id: number;
    entity_type: EntityMediaType;
    entity_key: string;
    appearance: EntityAppearance | null;
    personality: EntityPersonality | null;
    evidence: TraitEvidence[];
    confidence: TraitConfidence | null;
    provider: string | null;
    model: string | null;
    /** True for a hand-written edit; a generated dossier never sets it. */
    isManual: boolean;
    /**
     * The field paths this write sets by hand, e.g. `['eyes', 'hair.colour']`.
     * A path whose value is empty is *released*: the AI may fill it again.
     */
    manualFields?: string[];
}

export interface EntityProfileSaveResult {
    saved: EntityProfileEntry | null;
    /** Fields an analysis left untouched because a person owns them. */
    keptFields: string[];
}

export const entityProfileRepository = {
    getForEntity(
        campaignId: number,
        entityType: EntityMediaType,
        entityKey: string,
    ): EntityProfileEntry | null {
        return (
            db.prepare(
                'SELECT * FROM entity_profile WHERE campaign_id = ? AND entity_type = ? AND entity_key = ?',
            ).get(campaignId, entityType, entityKey) as EntityProfileEntry | undefined
        ) ?? null;
    },

    /**
     * Writes a dossier, merging rather than replacing.
     *
     * A manual write layers the given fields over what is there and claims them.
     * An analysis writes its own result and then puts the claimed fields back on
     * top — so the two can improve the same record over time without either
     * silently undoing the other.
     */
    upsert(entry: EntityProfileWrite): EntityProfileSaveResult {
        return db.transaction(() => {
            const existing = entityProfileRepository.getForEntity(
                entry.campaign_id,
                entry.entity_type,
                entry.entity_key,
            );
            const existingAppearance = (parseAppearance(existing) ?? {}) as Record<string, unknown>;
            const existingPersonality = parsePersonality(existing).fields ?? {};
            const owned = new Set(parseManualFields(existing));

            let appearance: Record<string, unknown>;
            let personality: Record<string, unknown>;
            let evidence: TraitEvidence[];
            let keptFields: string[] = [];

            if (entry.isManual) {
                appearance = { ...existingAppearance };
                personality = { ...existingPersonality };
                for (const path of entry.manualFields ?? []) {
                    const value = readPath(
                        { ...(entry.appearance ?? {}), personality: entry.personality ?? {} },
                        path,
                    );
                    const target = path.startsWith('personality.') ? personality : appearance;
                    const key = path.startsWith('personality.') ? path.slice('personality.'.length) : path;

                    if (value === undefined || value === null || value === '' ||
                        (Array.isArray(value) && value.length === 0)) {
                        // Cleared: released back to the AI rather than pinned empty.
                        deletePath(target, key);
                        owned.delete(path);
                    } else {
                        writePath(target, key, value);
                        owned.add(path);
                    }
                }
                // A quote no longer supports a value somebody replaced.
                evidence = parseEvidence(existing).filter(item => !owned.has(item.trait));
            } else {
                appearance = { ...((entry.appearance ?? {}) as Record<string, unknown>) };
                personality = { ...((entry.personality ?? {}) as Record<string, unknown>) };
                evidence = entry.evidence ?? [];

                for (const path of owned) {
                    const target = path.startsWith('personality.') ? personality : appearance;
                    const key = path.startsWith('personality.') ? path.slice('personality.'.length) : path;
                    const source = path.startsWith('personality.') ? existingPersonality : existingAppearance;
                    const value = readPath(source as Record<string, unknown>, key);
                    if (value === undefined) continue;
                    writePath(target, key, value);
                    keptFields.push(path);
                }
                evidence = evidence.filter(item => !owned.has(item.trait));
            }

            const now = Date.now();
            const hasAppearance = Object.keys(appearance).length > 0;
            const hasPersonality = Object.keys(personality).length > 0;

            db.prepare(`
                INSERT INTO entity_profile (
                    id, campaign_id, entity_type, entity_key,
                    appearance_json, appearance_text, personality_text,
                    evidence_json, confidence, is_manual, manual_fields,
                    provider, model, generated_at, stale_since_session_id,
                    created_at, updated_at
                ) VALUES (
                    @id, @campaign_id, @entity_type, @entity_key,
                    @appearance_json, @appearance_text, @personality_text,
                    @evidence_json, @confidence, @is_manual, @manual_fields,
                    @provider, @model, @generated_at, NULL,
                    @created_at, @updated_at
                )
                ON CONFLICT(campaign_id, entity_type, entity_key) DO UPDATE SET
                    appearance_json = excluded.appearance_json,
                    appearance_text = excluded.appearance_text,
                    personality_text = excluded.personality_text,
                    evidence_json = excluded.evidence_json,
                    confidence = excluded.confidence,
                    is_manual = excluded.is_manual,
                    manual_fields = excluded.manual_fields,
                    provider = excluded.provider,
                    model = excluded.model,
                    generated_at = excluded.generated_at,
                    -- A fresh write answers the staleness that prompted it.
                    stale_since_session_id = NULL,
                    updated_at = excluded.updated_at
            `).run({
                id: existing?.id ?? randomUUID(),
                campaign_id: entry.campaign_id,
                entity_type: entry.entity_type,
                entity_key: entry.entity_key,
                appearance_json: hasAppearance ? JSON.stringify(appearance) : null,
                appearance_text: hasAppearance ? renderFields(appearance) : null,
                personality_text: hasPersonality ? JSON.stringify(personality) : null,
                evidence_json: JSON.stringify(evidence),
                confidence: entry.confidence ?? existing?.confidence ?? null,
                is_manual: owned.size > 0 ? 1 : 0,
                manual_fields: JSON.stringify([...owned]),
                provider: entry.provider ?? existing?.provider ?? null,
                model: entry.model ?? existing?.model ?? null,
                generated_at: entry.isManual ? existing?.generated_at ?? now : now,
                created_at: existing?.created_at ?? now,
                updated_at: now,
            });

            return {
                saved: entityProfileRepository.getForEntity(
                    entry.campaign_id,
                    entry.entity_type,
                    entry.entity_key,
                ),
                keptFields,
            };
        })();
    },

    /**
     * Marks every dossier of a campaign whose subject appeared in a later
     * session as worth revisiting.
     *
     * It only sets a flag. Spending the table's money on a re-analysis is a
     * decision a person takes, and this is how they get told there is one to
     * take.
     */
    markStale(campaignId: number, sessionId: string, refs: Array<{
        entityType: EntityMediaType;
        entityKey: string;
    }>): number {
        if (refs.length === 0) return 0;
        const statement = db.prepare(`
            UPDATE entity_profile
            SET stale_since_session_id = @sessionId, updated_at = @now
            WHERE campaign_id = @campaignId
              AND entity_type = @entityType
              AND entity_key = @entityKey
              AND stale_since_session_id IS NULL
        `);
        const now = Date.now();
        return db.transaction(() => refs.reduce(
            (changed, ref) => changed + statement.run({
                campaignId,
                sessionId,
                now,
                entityType: ref.entityType,
                entityKey: ref.entityKey,
            }).changes,
            0,
        ))();
    },

    deleteForEntity(campaignId: number, entityType: EntityMediaType, entityKey: string): boolean {
        return db.prepare(
            'DELETE FROM entity_profile WHERE campaign_id = ? AND entity_type = ? AND entity_key = ?',
        ).run(campaignId, entityType, entityKey).changes > 0;
    },
};

/** The stored traits, or null when there are none or the JSON is unreadable. */
export function parseAppearance(entry: EntityProfileEntry | null): EntityAppearance | null {
    if (!entry?.appearance_json) return null;
    try {
        const parsed = JSON.parse(entry.appearance_json);
        return parsed && typeof parsed === 'object' ? (parsed as EntityAppearance) : null;
    } catch {
        return null;
    }
}

export function parseEvidence(entry: EntityProfileEntry | null): TraitEvidence[] {
    if (!entry?.evidence_json) return [];
    try {
        const parsed = JSON.parse(entry.evidence_json);
        return Array.isArray(parsed) ? (parsed as TraitEvidence[]) : [];
    } catch {
        return [];
    }
}

/** The field paths a person owns. Anything unreadable means «nobody owns anything». */
export function parseManualFields(entry: EntityProfileEntry | null): string[] {
    if (!entry?.manual_fields) return [];
    try {
        const parsed = JSON.parse(entry.manual_fields);
        return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * The temperament, which is stored as JSON when fields were filled and as plain
 * text when an older version of this feature kept somebody's prose.
 */
export function parsePersonality(entry: EntityProfileEntry | null): {
    fields: EntityPersonality | null;
    text: string | null;
} {
    const raw = entry?.personality_text ?? null;
    if (!raw) return { fields: null, text: null };
    if (!raw.trimStart().startsWith('{')) return { fields: null, text: raw };
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object'
            ? { fields: parsed as EntityPersonality, text: null }
            : { fields: null, text: raw };
    } catch {
        return { fields: null, text: raw };
    }
}

/** `hair.colour` → the value inside `{ hair: { colour } }`. */
function readPath(source: Record<string, unknown>, path: string): unknown {
    const [head, tail] = path.split('.');
    const value = source[head];
    if (!tail) return value;
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[tail] : undefined;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
    const [head, tail] = path.split('.');
    if (!tail) {
        target[head] = value;
        return;
    }
    const nested = target[head] && typeof target[head] === 'object'
        ? { ...(target[head] as Record<string, unknown>) }
        : {};
    nested[tail] = value;
    target[head] = nested;
}

function deletePath(target: Record<string, unknown>, path: string): void {
    const [head, tail] = path.split('.');
    if (!tail) {
        delete target[head];
        return;
    }
    if (!target[head] || typeof target[head] !== 'object') return;
    const nested = { ...(target[head] as Record<string, unknown>) };
    delete nested[tail];
    if (Object.keys(nested).length === 0) delete target[head];
    else target[head] = nested;
}

/**
 * The dossier as a person reads it.
 *
 * Rendered from the fields rather than asked of a model: a second generative
 * step to turn facts into a sentence is a second chance to add one that was not
 * there.
 */
export function renderFields(appearance: Record<string, unknown>): string | null {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(appearance)) {
        if (value === null || value === undefined) continue;
        const label = key.replace(/_/g, ' ');
        if (Array.isArray(value)) {
            if (value.length > 0) parts.push(`${label}: ${value.join(', ')}`);
        } else if (typeof value === 'object') {
            const inner = Object.entries(value as Record<string, unknown>)
                .filter(([, nested]) => typeof nested === 'string' && nested.trim() !== '')
                .map(([nestedKey, nested]) => `${nestedKey} ${nested}`)
                .join(', ');
            if (inner) parts.push(`${label}: ${inner}`);
        } else if (String(value).trim() !== '') {
            parts.push(`${label}: ${String(value).trim()}`);
        }
    }

    return parts.length > 0 ? parts.join('; ') : null;
}
