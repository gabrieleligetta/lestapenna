/**
 * What the campaign's own records say about one subject.
 *
 * Extracted from `imagePrompt.ts` when the appearance analysis needed the same
 * reading: two callers looking up the same entity through two slightly
 * different sets of repositories is how a dossier ends up describing a subject
 * the portrait was never drawn from.
 *
 * Everything here is a lookup by the **public** short id — the one in the URL —
 * because that is the only identifier the web and the bot both hold. Passing an
 * internal row id here type-checks and finds nothing.
 */

import { artifactRepository } from '../db/repositories/ArtifactRepository';
import { characterRepository } from '../db/repositories/CharacterRepository';
import { factionRepository } from '../db/repositories/FactionRepository';
import { locationRepository } from '../db/repositories/LocationRepository';
import { npcRepository } from '../db/repositories/NpcRepository';
import type { EntityMediaType } from '../db/types';

/**
 * Which vocabulary of visible traits applies.
 *
 * A place has no temperament and a sword has no bearing: the three shapes are
 * what stops the extractor being asked for fields that cannot exist.
 */
export type SubjectKind = 'person' | 'place' | 'object';

export const SUBJECT_KIND: Record<EntityMediaType, SubjectKind> = {
    npc: 'person',
    character: 'person',
    location: 'place',
    artifact: 'object',
};

export interface SubjectFacts {
    name: string;
    kind: SubjectKind;
    /** `Label: value` lines, ready to hand to a model or render for a person. */
    facts: string[];
    /** Factions the subject belongs to — where livery and uniform are described. */
    factions: string[];
}

export function subjectFacts(
    campaignId: number,
    entityType: EntityMediaType,
    entityId: string,
): SubjectFacts | null {
    if (entityType === 'npc') {
        const npc = npcRepository.getNpcByShortId(campaignId, entityId);
        if (!npc) return null;
        return {
            name: npc.name,
            kind: 'person',
            facts: labelled([
                ['Role', npc.role],
                ['Status', npc.status],
                // What a person wrote by hand outranks what was inferred from play.
                ['Description', npc.manual_description ?? npc.description],
                ['Also known as', npc.aliases],
                ['Last seen at', npc.last_seen_location],
            ]),
            factions: factionNames('npc', npc.id),
        };
    }

    if (entityType === 'location') {
        const place = locationRepository.getAtlasEntryByShortId(campaignId, entityId);
        if (!place) return null;
        return {
            name: place.micro_location,
            kind: 'place',
            facts: labelled([
                ['Region', place.macro_location],
                ['Description', place.manual_description ?? place.description],
            ]),
            factions: factionNames('location', place.id),
        };
    }

    if (entityType === 'artifact') {
        const artifact = artifactRepository.getArtifactByShortId(campaignId, entityId);
        if (!artifact) return null;
        return {
            name: artifact.name,
            kind: 'object',
            facts: labelled([
                ['Description', artifact.description],
                ['Effects', artifact.effects],
                ['Cursed', artifact.is_cursed === 1 ? (artifact.curse_description ?? 'yes') : null],
                ['Status', artifact.status],
            ]),
            factions: [],
        };
    }

    const profile = characterRepository.getUserProfile(entityId, campaignId);
    if (!profile?.character_name) return null;
    const rowId = characterRepository.getCharacterRowId(entityId, campaignId);
    return {
        name: profile.character_name,
        kind: 'person',
        facts: labelled([
            ['Race', profile.race],
            ['Class', profile.class],
            // The player's own words about their character outrank the generated bio.
            ['Description', profile.foundation_description ?? profile.description],
        ]),
        factions: rowId === null ? [] : factionNames('pc', rowId),
    };
}

function factionNames(entityType: 'npc' | 'location' | 'pc', entityId: number): string[] {
    try {
        return factionRepository
            .getEntityFactions(entityType, entityId)
            .map(affiliation => (affiliation as { faction_name?: string }).faction_name)
            .filter((name): name is string => typeof name === 'string' && name.trim() !== '');
    } catch {
        // A subject with no affiliations is the common case, and a campaign
        // without the affiliation table populated is not a reason to fail a
        // portrait.
        return [];
    }
}

function labelled(pairs: Array<[string, string | null | undefined]>): string[] {
    return pairs
        .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
        .map(([label, value]) => `${label}: ${String(value).trim()}`);
}
