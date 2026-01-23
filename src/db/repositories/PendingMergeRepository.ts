import { db } from '../client';
import { PendingMerge } from '../types';

export const pendingMergeRepository = {
    addPendingMerge: (data: PendingMerge) => {
        db.prepare(`
            INSERT OR REPLACE INTO pending_merges (message_id, campaign_id, detected_name, target_name, new_description, role)
            VALUES ($messageId, $campaignId, $detectedName, $targetName, $newDescription, $role)
        `).run({
            messageId: data.message_id,
            campaignId: data.campaign_id,
            detectedName: data.detected_name,
            targetName: data.target_name,
            newDescription: data.new_description,
            role: data.role
        });
    },

    removePendingMerge: (messageId: string) => {
        db.prepare('DELETE FROM pending_merges WHERE message_id = ?').run(messageId);
    },

    getAllPendingMerges: (): PendingMerge[] => {
        return db.prepare('SELECT * FROM pending_merges').all() as PendingMerge[];
    }
};
