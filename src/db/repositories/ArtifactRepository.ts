/**
 * Artifact Repository - CRUD and history operations for magical artifacts
 */

import { db } from '../client';
import { ArtifactEntry, ArtifactHistoryEntry, ArtifactStatus, ArtifactOwnerType } from '../types';
import { generateShortId } from '../utils/idGenerator';

export interface ArtifactDetails {
    description?: string;
    effects?: string;
    is_cursed?: boolean;
    curse_description?: string;
    owner_type?: ArtifactOwnerType;
    owner_id?: number;
    owner_name?: string;
    location_macro?: string;
    location_micro?: string;
    faction_id?: number;
}

export const artifactRepository = {
    upsertArtifact: (
        campaignId: number,
        name: string,
        status: ArtifactStatus = 'FUNCTIONAL',
        sessionId?: string,
        details?: ArtifactDetails,
        isManual: boolean = false,
        timestamp?: number
    ): void => {
        // Check if exists to determine if we need a new short_id
        const existing = artifactRepository.getArtifactByName(campaignId, name);
        const shortId = existing?.short_id || generateShortId('artifacts');

        db.prepare(`
            INSERT INTO artifacts (
                campaign_id, name, status, description, effects,
                is_cursed, curse_description, owner_type, owner_id, owner_name,
                location_macro, location_micro, faction_id,
                first_session_id, rag_sync_needed, is_manual, short_id, manual_description
            )
            VALUES (
                $campaignId, $name, $status, $description, $effects,
                $isCursed, $curseDesc, $ownerType, $ownerId, $ownerName,
                $locationMacro, $locationMicro, $factionId,
                $sessionId, 1, $isManual, $shortId, CASE WHEN $isManual = 1 THEN $description ELSE NULL END
            )
            ON CONFLICT(campaign_id, name)
            DO UPDATE SET 
                status = COALESCE($status, status),
                description = COALESCE($description, description),
                effects = COALESCE($effects, effects),
                is_cursed = COALESCE($isCursed, is_cursed),
                curse_description = COALESCE($curseDesc, curse_description),
                owner_type = COALESCE($ownerType, owner_type),
                owner_id = COALESCE($ownerId, owner_id),
                owner_name = COALESCE($ownerName, owner_name),
                location_macro = COALESCE($locationMacro, location_macro),
                location_micro = COALESCE($locationMicro, location_micro),
                faction_id = COALESCE($factionId, faction_id),
                last_updated = CURRENT_TIMESTAMP,
                rag_sync_needed = 1,
                is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END,
                manual_description = CASE WHEN $isManual = 1 THEN $description ELSE manual_description END
        `).run({
            campaignId,
            name,
            status,
            description: details?.description || null,
            effects: details?.effects || null,
            isCursed: details?.is_cursed ? 1 : 0,
            curseDesc: details?.curse_description || null,
            ownerType: details?.owner_type || null,
            ownerId: details?.owner_id || null,
            ownerName: details?.owner_name || null,
            locationMacro: details?.location_macro || null,
            locationMicro: details?.location_micro || null,
            factionId: details?.faction_id || null,
            sessionId: sessionId || null,
            isManual: isManual ? 1 : 0,
            shortId
        });

        console.log(`[Artifact] ✨ Artefatto tracciato/aggiornato: ${name} [#${shortId}]`);
    },

    getArtifactByName: (campaignId: number, name: string): ArtifactEntry | null => {
        return db.prepare(`
            SELECT * FROM artifacts 
            WHERE campaign_id = ? AND lower(name) = lower(?)
            LIMIT 1
        `).get(campaignId, name) as ArtifactEntry | null;
    },

    getArtifactByShortId: (campaignId: number, shortId: string): ArtifactEntry | null => {
        const cleanId = shortId.startsWith('#') ? shortId.substring(1) : shortId;
        return db.prepare(`
            SELECT * FROM artifacts 
            WHERE campaign_id = ? AND short_id = ?
            LIMIT 1
        `).get(campaignId, cleanId) as ArtifactEntry | null;
    },

    listAllArtifacts: (campaignId: number): ArtifactEntry[] => {
        return db.prepare(`
            SELECT * FROM artifacts 
            WHERE campaign_id = ? 
            ORDER BY name ASC
        `).all(campaignId) as ArtifactEntry[];
    },

    listArtifacts: (campaignId: number, limit: number = 20): ArtifactEntry[] => {
        return db.prepare(`
            SELECT * FROM artifacts
            WHERE campaign_id = ?
            ORDER BY last_updated DESC
            LIMIT ?
        `).all(campaignId, limit) as ArtifactEntry[];
    },

    deleteArtifact: (campaignId: number, name: string): boolean => {
        const res = db.prepare('DELETE FROM artifacts WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
        if (res.changes > 0) {
            db.prepare('DELETE FROM artifact_history WHERE campaign_id = ? AND lower(artifact_name) = lower(?)').run(campaignId, name);
        }
        return res.changes > 0;
    },

    addArtifactEvent: (
        campaignId: number,
        artifactName: string,
        sessionId: string,
        description: string,
        eventType: string,
        isManual: boolean = false,
        timestamp?: number
    ): void => {
        db.prepare(`
            INSERT INTO artifact_history (campaign_id, artifact_name, session_id, description, event_type, timestamp, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, artifactName, sessionId, description, eventType, timestamp || Date.now(), isManual ? 1 : 0);
    },

    getArtifactHistory: (campaignId: number, artifactName: string): ArtifactHistoryEntry[] => {
        return db.prepare(`
            SELECT * FROM artifact_history 
            WHERE campaign_id = ? AND lower(artifact_name) = lower(?)
            ORDER BY timestamp ASC
        `).all(campaignId, artifactName) as ArtifactHistoryEntry[];
    },

    markArtifactDirty: (campaignId: number, name: string): void => {
        db.prepare('UPDATE artifacts SET rag_sync_needed = 1 WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
    },

    getDirtyArtifacts: (campaignId: number): ArtifactEntry[] => {
        return db.prepare('SELECT * FROM artifacts WHERE campaign_id = ? AND rag_sync_needed = 1').all(campaignId) as ArtifactEntry[];
    },

    clearArtifactDirtyFlag: (campaignId: number, name: string): void => {
        db.prepare('UPDATE artifacts SET rag_sync_needed = 0 WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
    },

    updateArtifactDescription: (campaignId: number, name: string, description: string): void => {
        db.prepare(`
            UPDATE artifacts 
            SET description = ?, rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).run(description, campaignId, name);
    },

    mergeArtifacts: (
        campaignId: number,
        oldName: string,
        newName: string,
        mergedDescription?: string
    ): boolean => {
        const source = artifactRepository.getArtifactByName(campaignId, oldName);
        const target = artifactRepository.getArtifactByName(campaignId, newName);

        if (!source) return false;

        db.transaction(() => {
            if (target) {
                // Merge into target
                const mergedDesc = mergedDescription || target.description || source.description;
                const mergedEffects = target.effects || source.effects;

                db.prepare(`
                    UPDATE artifacts 
                    SET description = ?, effects = ?, rag_sync_needed = 1
                    WHERE id = ?
                `).run(mergedDesc, mergedEffects, target.id);

                // Update history to point to new name
                db.prepare(`
                    UPDATE artifact_history 
                    SET artifact_name = ? 
                    WHERE campaign_id = ? AND lower(artifact_name) = lower(?)
                `).run(newName, campaignId, oldName);

                // Delete source
                db.prepare('DELETE FROM artifacts WHERE id = ?').run(source.id);
            } else {
                // Just rename
                db.prepare('UPDATE artifacts SET name = ? WHERE id = ?').run(newName, source.id);
                if (mergedDescription) {
                    db.prepare('UPDATE artifacts SET description = ? WHERE id = ?').run(mergedDescription, source.id);
                }
                db.prepare(`
                    UPDATE artifact_history 
                    SET artifact_name = ? 
                    WHERE campaign_id = ? AND lower(artifact_name) = lower(?)
                `).run(newName, campaignId, oldName);
            }
        })();

        console.log(`[Artifact] 🔀 Merged: ${oldName} -> ${newName}`);
        return true;
    },

    updateArtifactFields: (
        campaignId: number,
        name: string,
        fields: Partial<{
            status: ArtifactStatus;
            description: string;
            effects: string;
            owner_type: ArtifactOwnerType;
            owner_name: string;
            location_macro: string;
            location_micro: string;
            is_cursed: boolean;
            curse_description: string;
        }>,
        isManual: boolean = false
    ): boolean => {
        const artifact = artifactRepository.getArtifactByName(campaignId, name);
        if (!artifact) return false;

        const updates: string[] = [];
        const params: any = { id: artifact.id };

        if (fields.status !== undefined) {
            updates.push('status = $status');
            params.status = fields.status;
        }
        if (fields.description !== undefined) {
            updates.push('description = $description');
            params.description = fields.description;
            if (isManual) {
                updates.push('manual_description = $description');
            }
        }
        if (fields.effects !== undefined) {
            updates.push('effects = $effects');
            params.effects = fields.effects;
        }
        if (fields.owner_type !== undefined) {
            updates.push('owner_type = $ownerType');
            params.ownerType = fields.owner_type;
        }
        if (fields.owner_name !== undefined) {
            updates.push('owner_name = $ownerName');
            params.ownerName = fields.owner_name;
        }
        if (fields.location_macro !== undefined) {
            updates.push('location_macro = $locationMacro');
            params.locationMacro = fields.location_macro;
        }
        if (fields.location_micro !== undefined) {
            updates.push('location_micro = $locationMicro');
            params.locationMicro = fields.location_micro;
        }
        if (fields.is_cursed !== undefined) {
            updates.push('is_cursed = $isCursed');
            params.isCursed = fields.is_cursed ? 1 : 0;
        }
        if (fields.curse_description !== undefined) {
            updates.push('curse_description = $curseDesc');
            params.curseDesc = fields.curse_description;
        }

        if (updates.length === 0) return false;

        updates.push('rag_sync_needed = 1');
        updates.push('last_updated = CURRENT_TIMESTAMP');
        if (isManual) updates.push('is_manual = 1');

        db.prepare(`UPDATE artifacts SET ${updates.join(', ')} WHERE id = $id`).run(params);
        return true;
    }
};
