/**
 * Shared helpers for the entity → RAG synchronization.
 *
 * Every per-entity sync file had the same batch skeleton copied
 * (chunks of 5 → generateBioBatch → finalize per element) and duplicated
 * its own RAG card builder between the single and the batch path.
 * The batch loop lives here; the builders stay in the per-entity files but in a
 * single copy each.
 */

import { generateBioBatch, BioEntityType } from '../bio';

export interface BatchBioItem<T> {
    entity: T;
    name: string;
    context: any;      // BioContext per generateBioBatch
    history: string;
}

/**
 * Shared batch loop: processes the dirty entities in groups of `batchSize`,
 * generates the bios in one AI call per group and invokes `finalize` for each
 * with the new bio (or the current description as a fallback).
 * Returns the number of entities processed.
 */
export async function syncDirtyInBatches<T>(
    dirty: T[],
    bioType: BioEntityType,
    buildInput: (entity: T) => BatchBioItem<T>,
    finalize: (entity: T, newBio: string) => Promise<void>,
    batchSize = 5
): Promise<number> {
    if (dirty.length === 0) return 0;

    for (let i = 0; i < dirty.length; i += batchSize) {
        const batch = dirty.slice(i, i + batchSize);
        const inputs = batch.map(buildInput);

        const results = await generateBioBatch(bioType, inputs);

        for (const input of inputs) {
            const newBio = results[input.name] || input.context.currentDesc || '';
            await finalize(input.entity, newBio);
        }
    }

    return dirty.length;
}

/** Standard tail of every official RAG card. */
export const RAG_PRIORITY_FOOTER = `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

/** Formats an entity's history for the bio prompt (the last 20 events). */
export function formatHistoryEvents(history: Array<{ description: string; event_type: string }>): string {
    return history.map(h => `[${h.event_type}] ${h.description}`).slice(-20).join('\n');
}
