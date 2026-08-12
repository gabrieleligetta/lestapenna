import { db } from '../client';
import {
    AlignmentHistoryTable,
    isAlignmentHistoryTable,
    recomputeAlignmentForHistory,
} from './shared';

/** The column carrying the entity name in the weighted history tables. */
const ALIGNMENT_NAME_COLUMN: Record<AlignmentHistoryTable, string> = {
    npc_history: 'npc_name',
    character_history: 'character_name',
    faction_history: 'faction_name',
};

/**
 * Campaign + name of the entity the event belongs to, read from the row
 * itself: needed to re-aggregate the alignment after an edit or a deletion.
 * `tableName` is always a literal from the caller, never user input.
 */
function eventOwner(
    tableName: AlignmentHistoryTable,
    eventId: number,
): { campaign_id: number; name: string | null } | undefined {
    return db.prepare(
        `SELECT campaign_id, ${ALIGNMENT_NAME_COLUMN[tableName]} AS name
         FROM ${tableName} WHERE id = ?`
    ).get(eventId) as { campaign_id: number; name: string | null } | undefined;
}

export interface EventWeights {
    moral_weight?: number;
    ethical_weight?: number;
}

export const eventRepository = {
    /**
     * Updates a generic event in any history table.
     *
     * `weights` is only honoured on npc/character/faction history — the three
     * tables that carry moral_weight/ethical_weight. Changing one of them
     * re-aggregates the parent entity's alignment in the same transaction, so
     * the score can never disagree with the events it is derived from.
     */
    updateEvent: (
        tableName: string,
        eventId: number,
        description: string,
        sessionId?: string,
        type?: string,
        timestamp?: number,
        weights?: EventWeights,
    ): boolean => {
        const sets: string[] = ['description = @description', 'is_manual = 1'];
        const params: any = { description, id: eventId };

        if (sessionId !== undefined) {
            sets.push('session_id = @sessionId');
            params.sessionId = sessionId;
        }

        if (type !== undefined) {
            sets.push('event_type = @type');
            params.type = type;
        }

        if (timestamp !== undefined) {
            sets.push('timestamp = @timestamp');
            params.timestamp = timestamp;
        }

        const weighted = isAlignmentHistoryTable(tableName);
        if (weighted && weights?.moral_weight !== undefined) {
            sets.push('moral_weight = @moralWeight');
            params.moralWeight = weights.moral_weight;
        }
        if (weighted && weights?.ethical_weight !== undefined) {
            sets.push('ethical_weight = @ethicalWeight');
            params.ethicalWeight = weights.ethical_weight;
        }

        if (tableName === 'world_history') {
            sets.push('rag_sync_needed = 1');
        }
        // World history is handled directly by EventRepository (it sets rag_sync_needed on the row)

        // Character history sync is complex, often manual or strictly session based.

        let changed = false;
        db.transaction(() => {
            const owner = weighted ? eventOwner(tableName as AlignmentHistoryTable, eventId) : undefined;

            const res = db.prepare(`
                UPDATE ${tableName}
                SET ${sets.join(', ')}
                WHERE id = @id
            `).run(params);
            changed = res.changes > 0;

            if (changed && owner?.name) {
                recomputeAlignmentForHistory(
                    owner.campaign_id,
                    tableName as AlignmentHistoryTable,
                    owner.name,
                );
            }
        })();

        return changed;
    },

    /**
     * Deletes a generic event. On a weighted history table the parent entity's
     * alignment is re-aggregated afterwards, since the deleted row was one of
     * the samples the average was built from.
     */
    deleteEvent: (tableName: string, eventId: number): boolean => {
        const weighted = isAlignmentHistoryTable(tableName);
        let changed = false;

        db.transaction(() => {
            const owner = weighted ? eventOwner(tableName as AlignmentHistoryTable, eventId) : undefined;

            const res = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(eventId);
            changed = res.changes > 0;

            if (changed && owner?.name) {
                recomputeAlignmentForHistory(
                    owner.campaign_id,
                    tableName as AlignmentHistoryTable,
                    owner.name,
                );
            }
        })();

        return changed;
    },

    /**
     * Gets a single event by ID
     */
    getEventById: (tableName: string, eventId: number): any | undefined => {
        return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(eventId);
    },

    /**
     * Adds a new event to any history table
     */
    addEvent: (
        tableName: string,
        entityColumn: string,
        entityValue: string,
        campaignId: number,
        description: string,
        type: string,
        sessionId?: string,
        timestamp?: number,
        secondaryEntityColumn?: string,
        secondaryEntityValue?: string
    ): void => {
        let columns = `(campaign_id, ${entityColumn}, session_id, description, event_type, timestamp, is_manual`;
        let values = `VALUES (@campaignId, @entityValue, @sessionId, @description, @type, @timestamp, 1`;
        const params: any = {
            campaignId,
            entityValue,
            sessionId: sessionId || null,
            description,
            type,
            timestamp: timestamp || Date.now()
        };

        if (secondaryEntityColumn && secondaryEntityValue) {
            columns += `, ${secondaryEntityColumn}`;
            values += `, @secondaryEntityValue`;
            params.secondaryEntityValue = secondaryEntityValue;
        }

        if (tableName === 'world_history') {
            columns += `, rag_sync_needed`;
            values += `, 1`;
        }

        columns += `)`;
        values += `)`;

        db.prepare(`
            INSERT INTO ${tableName}
            ${columns}
            ${values}
        `).run(params);
    }
};
