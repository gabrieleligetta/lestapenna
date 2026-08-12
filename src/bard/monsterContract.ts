/**
 * Boundary sanitizer for analyst/cache payloads created before the bestiary
 * quantity field was removed. The legacy property is discarded instead of
 * reaching ingestion, notifications or newly persisted summary data.
 */
export function normalizeMonsterList(value: unknown): any[] {
    if (!Array.isArray(value)) return [];

    return value
        .filter(monster => monster && typeof monster === 'object' && (monster as any).name)
        .map(monster => {
            const normalized = { ...(monster as Record<string, unknown>) };
            delete normalized.count;
            return normalized;
        });
}
