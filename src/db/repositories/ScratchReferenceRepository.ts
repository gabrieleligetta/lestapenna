import { randomUUID } from 'crypto';
import { db } from '../client';
import type { ScratchReferenceEntry } from '../types';

export type NewScratchReference = Omit<ScratchReferenceEntry, 'id' | 'job_id' | 'created_at'>;

export const scratchReferenceRepository = {
    add(entry: NewScratchReference): ScratchReferenceEntry {
        const id = randomUUID();
        const createdAt = Date.now();
        db.prepare(`
            INSERT INTO image_reference_scratch (
                id, campaign_id, object_key, mime_type, width, height, size_bytes,
                label, roles_json, instruction, uploaded_by, job_id, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(
            id,
            entry.campaign_id,
            entry.object_key,
            entry.mime_type,
            entry.width,
            entry.height,
            entry.size_bytes,
            entry.label,
            entry.roles_json,
            entry.instruction,
            entry.uploaded_by,
            entry.expires_at,
            createdAt,
        );
        return scratchReferenceRepository.getById(entry.campaign_id, id)!;
    },

    getById(campaignId: number, id: string): ScratchReferenceEntry | null {
        return (db.prepare(`
            SELECT * FROM image_reference_scratch WHERE campaign_id = ? AND id = ?
        `).get(campaignId, id) as ScratchReferenceEntry | undefined) ?? null;
    },

    attachToJob(campaignId: number, id: string, jobId: string, expiresAt: number): boolean {
        return db.prepare(`
            UPDATE image_reference_scratch
            SET job_id = ?, expires_at = ?
            WHERE campaign_id = ? AND id = ? AND job_id IS NULL AND expires_at > ?
        `).run(jobId, expiresAt, campaignId, id, Date.now()).changes === 1;
    },

    /** All-or-nothing attachment: one missing input must not strand the rest. */
    attachManyToJob(campaignId: number, ids: string[], jobId: string, expiresAt: number): boolean {
        if (ids.length === 0) return true;
        return db.transaction(() => {
            const now = Date.now();
            for (const id of ids) {
                const row = scratchReferenceRepository.getById(campaignId, id);
                if (!row || row.job_id !== null || row.expires_at <= now) return false;
            }
            const statement = db.prepare(`
                UPDATE image_reference_scratch SET job_id = ?, expires_at = ?
                WHERE campaign_id = ? AND id = ? AND job_id IS NULL AND expires_at > ?
            `);
            for (const id of ids) {
                if (statement.run(jobId, expiresAt, campaignId, id, now).changes !== 1) {
                    // Throwing rolls the transaction back. It is caught just
                    // outside so callers still receive a simple false.
                    throw new Error('SCRATCH_REFERENCE_ATTACH_RACE');
                }
            }
            return true;
        })();
    },

    updateMetadata(
        campaignId: number,
        id: string,
        rolesJson: string,
        instruction: string | null,
    ): ScratchReferenceEntry | null {
        db.prepare(`
            UPDATE image_reference_scratch SET roles_json = ?, instruction = ?
            WHERE campaign_id = ? AND id = ? AND job_id IS NULL
        `).run(rolesJson, instruction, campaignId, id);
        return scratchReferenceRepository.getById(campaignId, id);
    },

    listExpired(now: number): ScratchReferenceEntry[] {
        return db.prepare(`
            SELECT * FROM image_reference_scratch WHERE expires_at <= ? ORDER BY expires_at ASC
        `).all(now) as ScratchReferenceEntry[];
    },

    remove(campaignId: number, id: string): ScratchReferenceEntry | null {
        return db.transaction(() => {
            const row = scratchReferenceRepository.getById(campaignId, id);
            if (!row) return null;
            db.prepare('DELETE FROM image_reference_scratch WHERE id = ?').run(id);
            return row;
        })();
    },

    removeById(id: string): void {
        db.prepare('DELETE FROM image_reference_scratch WHERE id = ?').run(id);
    },
};
