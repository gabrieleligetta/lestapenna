import { db } from '../client';

export const eventRepository = {
    /**
     * Updates a generic event in any history table
     */
    updateEvent: (tableName: string, eventId: number, description: string, sessionId?: string, type?: string, timestamp?: number): boolean => {
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

        if (tableName === 'world_history') {
            sets.push('rag_sync_needed = 1');
        }
        // World history is handled directly by EventRepository (it sets rag_sync_needed on the row)

        // Character history sync is complex, often manual or strictly session based.

        const res = db.prepare(`
            UPDATE ${tableName} 
            SET ${sets.join(', ')} 
            WHERE id = @id
        `).run(params);

        return res.changes > 0;
    },

    /**
     * Deletes a generic event
     */
    deleteEvent: (tableName: string, eventId: number): boolean => {
        const res = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(eventId);
        return res.changes > 0;
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
