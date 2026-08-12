import { getCharacterHistory, getNpcHistory } from '../../db';
import { generateBio } from '../bio';

/** @deprecated Use BioGenerator directly. */
export async function regenerateNpcNotes(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);
    return generateBio('NPC', { name: npcName, role, currentDesc: staticDesc }, history);
}

/** @deprecated Use BioGenerator directly. */
export async function generateNpcBiography(campaignId: number, npcName: string, role: string, staticDesc: string): Promise<string> {
    const history = getNpcHistory(campaignId, npcName);
    return generateBio('NPC', { name: npcName, role, currentDesc: staticDesc }, history);
}

/** @deprecated Use BioGenerator directly. */
export async function generateCharacterBiography(campaignId: number, charName: string, charClass: string, charRace: string): Promise<string> {
    const history = getCharacterHistory(campaignId, charName);
    return generateBio('CHARACTER', { name: charName, currentDesc: "", class: charClass, race: charRace }, history);
}
