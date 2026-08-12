import {
    getCampaignSnapshot,
    getQuestHistory,
    getOpenQuests,
    getNpcHistory,
    getNpcEntry,
    listNpcs,
    listAtlasEntries,
    getAtlasHistory,
    getInventoryHistory,
    getBestiaryHistory,
    getCampaignCharacters,
    factionRepository,
    recordingRepository,
    artifactRepository,
    questRepository,
    inventoryRepository,
    bestiaryRepository,
    getLatestSessionId,
    getFragmentsBySessionId,
    getExplicitSessionNumber
} from '../../db';
import { searchKnowledge } from '../rag';
import { AgentTool } from './runtime';
import { SessionRagIndex } from './sessionRag';

function asLimit(value: any, fallback: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(Math.floor(parsed), max);
}

function compactRecord(record: any): any {
    if (!record || typeof record !== 'object') return record;
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'string') result[key] = value.length > 600 ? value.substring(0, 600) + '...' : value;
        else result[key] = value;
    }
    return result;
}

function manifestoSections(manifesto: string): Record<string, string> {
    const sections: Record<string, string> = {};
    if (!manifesto) return sections;

    const parts = manifesto.split(/\n(?=#{2,3}\s+)/g);
    for (const part of parts) {
        const title = (part.match(/^#{2,3}\s*(.+)$/m)?.[1] || 'overview')
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .trim()
            .toLowerCase();
        if (title) sections[title] = part.substring(0, 5000);
    }
    if (Object.keys(sections).length === 0) sections.overview = manifesto.substring(0, 5000);
    return sections;
}

export function createAgentTools(campaignId: number, sessionRag: SessionRagIndex, manifesto: string = ''): AgentTool[] {
    const manifestoIndex = manifestoSections(manifesto);

    return [
        {
            name: 'get_transcript_overview',
            description: 'Restituisce una vista deterministica della trascrizione corrente: dimensione, speaker, luoghi e numero frammenti.',
            parameters: {},
            async run() {
                return sessionRag.overview();
            }
        },
        {
            name: 'list_transcript_mentions',
            description: 'Elenca battute della trascrizione corrente che menzionano un nome, luogo, oggetto, quest o fazione.',
            parameters: { query: 'Nome o termine da cercare', limit: 'Numero massimo occorrenze, default 12' },
            async run(args) {
                return sessionRag.mentions(String(args.query || ''), asLimit(args.limit, 12, 30));
            }
        },
        {
            name: 'list_speaker_turns',
            description: 'Elenca le battute di uno speaker/PG nella trascrizione corrente.',
            parameters: { speaker: 'Nome speaker/PG', limit: 'Numero massimo battute, default 10' },
            async run(args) {
                return sessionRag.speakerTurns(String(args.speaker || ''), asLimit(args.limit, 10, 30));
            }
        },
        {
            name: 'list_transcript_locations',
            description: 'Restituisce i luoghi della trascrizione corrente in ordine cronologico, se marcati.',
            parameters: {},
            async run() {
                return sessionRag.locationsInOrder();
            }
        },
        {
            name: 'list_candidate_names',
            description: 'Restituisce candidati nomi propri estratti deterministicamente dalla trascrizione corrente, con frequenza.',
            parameters: { limit: 'Numero massimo candidati, default 60' },
            async run(args) {
                return sessionRag.candidateNames(asLimit(args.limit, 60, 120));
            }
        },
        {
            name: 'search_manifesto',
            description: 'Cerca nel manifesto della campagna cacheato/sezionato. Usalo per contesto globale invece di tenere il manifesto intero nel prompt.',
            parameters: { query: 'Termini da cercare nel manifesto', limit: 'Numero massimo sezioni, default 3' },
            async run(args) {
                const query = String(args.query || '').toLowerCase();
                const limit = asLimit(args.limit, 3, 8);
                const rows = Object.entries(manifestoIndex)
                    .map(([section, content]) => {
                        const lc = content.toLowerCase();
                        const score = query
                            ? query.split(/\s+/).filter(Boolean).reduce((sum, token) => sum + (lc.includes(token) ? 1 : 0), 0)
                            : 1;
                        return { section, score, content: content.substring(0, 1800) };
                    })
                    .filter(row => row.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, limit);
                return rows;
            }
        },
        {
            name: 'get_manifesto_sections',
            description: 'Elenca le sezioni disponibili del manifesto cacheato.',
            parameters: {},
            async run() {
                return Object.keys(manifestoIndex);
            }
        },
        {
            name: 'search_historical_rag',
            description: 'Cerca nella memoria RAG storica della campagna, indicizzata dalle sessioni precedenti.',
            parameters: { query: 'Domanda o termini da cercare', limit: 'Numero massimo di frammenti, default 5' },
            async run(args) {
                const fragments = await searchKnowledge(campaignId, String(args.query || ''), asLimit(args.limit, 5, 8));
                return fragments.map(content => ({ content: content.substring(0, 1200) }));
            }
        },
        {
            name: 'search_session_rag',
            description: 'Cerca nella trascrizione della sessione corrente usando indice temporaneo read-only.',
            parameters: { query: 'Termini, NPC, luogo o quest da cercare', limit: 'Numero massimo di frammenti, default 5' },
            async run(args) {
                return sessionRag.search(String(args.query || ''), asLimit(args.limit, 3, 5))
                    .map(fragment => ({ id: fragment.id, score: fragment.score, content: fragment.content.substring(0, 900) }));
            }
        },
        {
            name: 'get_transcript_window',
            description: 'Recupera una finestra compatta della trascrizione corrente intorno a una query.',
            parameters: { query: 'Ancora testuale', chars: 'Dimensione massima in caratteri, default 5000' },
            async run(args) {
                return { content: sessionRag.windowAround(String(args.query || ''), asLimit(args.chars, 2500, 5000)) };
            }
        },
        {
            name: 'get_campaign_snapshot',
            description: 'Restituisce snapshot corrente della campagna: luogo, quest, contesto principale.',
            parameters: {},
            async run() {
                return compactRecord(getCampaignSnapshot(campaignId));
            }
        },
        {
            name: 'find_entities',
            description: 'Cerca entita note nel DB per tipo: npc, location, quest, item, monster, faction, artifact, character.',
            parameters: { type: 'Tipo entita', query: 'Filtro testuale opzionale', limit: 'Numero massimo risultati, default 10' },
            async run(args) {
                const type = String(args.type || '').toLowerCase();
                const query = String(args.query || '').toLowerCase();
                const limit = asLimit(args.limit, 10, 25);
                let rows: any[] = [];

                if (type === 'npc') rows = listNpcs(campaignId, 1000);
                else if (type === 'location') rows = listAtlasEntries(campaignId, 1000);
                else if (type === 'quest') rows = questRepository.listAllQuests(campaignId);
                else if (type === 'item') rows = inventoryRepository.listAllInventory(campaignId);
                else if (type === 'monster') rows = bestiaryRepository.listAllMonsters(campaignId);
                else if (type === 'faction') rows = factionRepository.listFactions(campaignId, true);
                else if (type === 'artifact') rows = artifactRepository.listArtifacts(campaignId, 1000);
                else if (type === 'character') rows = getCampaignCharacters(campaignId);

                return rows
                    .filter(row => !query || JSON.stringify(row).toLowerCase().includes(query))
                    .slice(0, limit)
                    .map(compactRecord);
            }
        },
        {
            name: 'get_entity_history',
            description: 'Recupera cronologia DB per npc, location, quest, item o monster.',
            parameters: { type: 'Tipo entita', name: 'Nome entita', limit: 'Numero massimo eventi, default 8' },
            async run(args) {
                const type = String(args.type || '').toLowerCase();
                const name = String(args.name || '');
                const limit = asLimit(args.limit, 8, 20);
                let rows: any[] = [];

                if (type === 'npc') rows = getNpcHistory(campaignId, name);
                else if (type === 'quest') rows = getQuestHistory(campaignId, name);
                else if (type === 'item') rows = getInventoryHistory(campaignId, name);
                else if (type === 'monster') rows = getBestiaryHistory(campaignId, name);
                else if (type === 'location') {
                    const [macro, micro] = name.includes(' - ')
                        ? name.split(' - ').map((part: string) => part.trim())
                        : ['', name];
                    rows = getAtlasHistory(campaignId, macro, micro);
                }

                return rows.slice(-limit).map(compactRecord);
            }
        },
        {
            name: 'get_open_quests',
            description: 'Elenca quest aperte della campagna.',
            parameters: { limit: 'Numero massimo risultati, default 12' },
            async run(args) {
                return getOpenQuests(campaignId, asLimit(args.limit, 12, 30)).map(compactRecord);
            }
        },
        {
            name: 'get_npc_dossier',
            description: 'Restituisce dossier compatto di un NPC per nome o alias.',
            parameters: { name: 'Nome o alias NPC' },
            async run(args) {
                return compactRecord(getNpcEntry(campaignId, String(args.name || '')));
            }
        },
        {
            name: 'resolve_entity',
            description: 'Verifica e normalizza un nome NPC o luogo contro il DB. Ritorna il nome/ID canonico se gia\' noto, altrimenti segnala che e\' nuovo. Usalo per evitare duplicati e nomi sporchi.',
            parameters: { type: 'npc | location', name: 'Nome da verificare' },
            async run(args) {
                const type = String(args.type || '').toLowerCase();
                const raw = String(args.name || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
                const low = raw.toLowerCase();
                if (!raw) return { match: false, reason: 'empty' };

                if (type === 'npc') {
                    const exact = getNpcEntry(campaignId, raw);
                    if (exact) return { match: true, canonical: (exact as any).name, id: (exact as any).short_id, status: (exact as any).status };
                    const all = listNpcs(campaignId, 1000);
                    const hit = all.find((n: any) =>
                        n.name?.toLowerCase() === low ||
                        n.name?.toLowerCase().includes(low) || low.includes(n.name?.toLowerCase()) ||
                        (n.aliases && `,${n.aliases.toLowerCase()},`.includes(`,${low},`)));
                    return hit
                        ? { match: true, canonical: hit.name, id: hit.short_id, status: hit.status }
                        : { match: false, hint: 'NPC nuovo: usa il nome proprio pulito, senza ruolo tra parentesi.' };
                }
                if (type === 'location') {
                    const all = listAtlasEntries(campaignId, 1000);
                    const hit = all.find((l: any) => {
                        const full = `${l.macro_location} - ${l.micro_location}`.toLowerCase();
                        return full === low || full.includes(low) || low.includes((l.micro_location || '').toLowerCase());
                    });
                    return hit
                        ? { match: true, location_id: hit.short_id, macro: hit.macro_location, micro: hit.micro_location }
                        : { match: false, hint: 'Luogo nuovo: usa gli stessi macro/micro che metti in travel_sequence/location_updates.' };
                }
                return { match: false, reason: 'type deve essere npc o location' };
            }
        }
    ];
}

/**
 * Reduced, read-only tool set for askBard (outside a session, with no sessionRag/manifesto
 * available): only DB/RAG lookups over the campaign's history, NEVER web search or general
 * knowledge. Used as an extra bounded layer on top of the existing RAG pipeline (askBard
 * invokes these tools ONLY when the context already retrieved is not enough), not as a
 * replacement for the current retrieval.
 */
/**
 * The two tools an appearance analysis needs and no other agent had.
 *
 * They are separate from `createBardoTools` because they answer a question the
 * chat never asks — *what does this look like* — and both reach material the
 * rest of the tool set cannot see: what a faction dresses its members in, and
 * what was said out loud at the table.
 */
export function createAppearanceTools(campaignId: number): AgentTool[] {
    return [
        {
            name: 'get_faction_profile',
            description: 'Returns a faction of this campaign with its description, so the livery, uniform or armour its members wear can be read. Use it for every faction the subject belongs to.',
            parameters: { name: 'Faction name, or part of it' },
            async run(args) {
                const query = String(args.name || '').trim();
                if (!query) return { found: false, reason: 'empty name' };

                const exact = factionRepository.getFaction(campaignId, query);
                const faction = exact ?? factionRepository.findFactionByName(campaignId, query)[0] ?? null;
                if (!faction) return { found: false, hint: 'No faction with this name in the campaign records.' };

                return {
                    found: true,
                    name: faction.name,
                    type: faction.type,
                    status: faction.status,
                    // The hand-written one first: what a person wrote about their
                    // own world outranks what was inferred from play.
                    description: faction.manual_description || faction.description || null,
                };
            },
        },
        {
            name: 'search_transcripts',
            description: 'Searches the verbatim recordings of past sessions for a name and returns the passages around each mention, with the session number. This is the only place where the exact words spoken at the table can be read; the RAG holds summaries, not speech.',
            parameters: { name: 'Name to look for', limit: 'Maximum passages, default 6' },
            async run(args) {
                const passages = recordingRepository.searchTranscripts(
                    campaignId,
                    String(args.name || ''),
                    asLimit(args.limit, 6, 12),
                );
                return passages.map(passage => ({
                    session: passage.session_number ?? passage.session_id,
                    excerpt: passage.excerpt,
                }));
            },
        },
    ];
}

export function createBardoTools(campaignId: number): AgentTool[] {
    return [
        {
            name: 'get_campaign_snapshot',
            description: 'Restituisce snapshot corrente della campagna: luogo, quest, contesto principale.',
            parameters: {},
            async run() {
                return compactRecord(getCampaignSnapshot(campaignId));
            }
        },
        {
            name: 'find_entities',
            description: 'Cerca entita note nel DB per tipo: npc, location, quest, item, monster, faction, artifact, character.',
            parameters: { type: 'Tipo entita', query: 'Filtro testuale opzionale', limit: 'Numero massimo risultati, default 10' },
            async run(args) {
                const type = String(args.type || '').toLowerCase();
                const query = String(args.query || '').toLowerCase();
                const limit = asLimit(args.limit, 10, 25);
                let rows: any[] = [];

                if (type === 'npc') rows = listNpcs(campaignId, 1000);
                else if (type === 'location') rows = listAtlasEntries(campaignId, 1000);
                else if (type === 'quest') rows = questRepository.listAllQuests(campaignId);
                else if (type === 'item') rows = inventoryRepository.listAllInventory(campaignId);
                else if (type === 'monster') rows = bestiaryRepository.listAllMonsters(campaignId);
                else if (type === 'faction') rows = factionRepository.listFactions(campaignId, true);
                else if (type === 'artifact') rows = artifactRepository.listArtifacts(campaignId, 1000);
                else if (type === 'character') rows = getCampaignCharacters(campaignId);

                return rows
                    .filter(row => !query || JSON.stringify(row).toLowerCase().includes(query))
                    .slice(0, limit)
                    .map(compactRecord);
            }
        },
        {
            name: 'get_entity_history',
            description: 'Recupera cronologia DB per npc, location, quest, item o monster.',
            parameters: { type: 'Tipo entita', name: 'Nome entita', limit: 'Numero massimo eventi, default 8' },
            async run(args) {
                const type = String(args.type || '').toLowerCase();
                const name = String(args.name || '');
                const limit = asLimit(args.limit, 8, 20);
                let rows: any[] = [];

                if (type === 'npc') rows = getNpcHistory(campaignId, name);
                else if (type === 'quest') rows = getQuestHistory(campaignId, name);
                else if (type === 'item') rows = getInventoryHistory(campaignId, name);
                else if (type === 'monster') rows = getBestiaryHistory(campaignId, name);
                else if (type === 'location') {
                    const [macro, micro] = name.includes(' - ')
                        ? name.split(' - ').map((part: string) => part.trim())
                        : ['', name];
                    rows = getAtlasHistory(campaignId, macro, micro);
                }

                return rows.slice(-limit).map(compactRecord);
            }
        },
        {
            name: 'get_open_quests',
            description: 'Elenca quest aperte della campagna.',
            parameters: { limit: 'Numero massimo risultati, default 12' },
            async run(args) {
                return getOpenQuests(campaignId, asLimit(args.limit, 12, 30)).map(compactRecord);
            }
        },
        {
            name: 'get_npc_dossier',
            description: 'Restituisce dossier compatto di un NPC per nome o alias.',
            parameters: { name: 'Nome o alias NPC' },
            async run(args) {
                return compactRecord(getNpcEntry(campaignId, String(args.name || '')));
            }
        },
        {
            name: 'resolve_entity',
            description: 'Verifica e normalizza un nome NPC o luogo contro il DB. Ritorna il nome/ID canonico se gia\' noto, altrimenti segnala che e\' nuovo.',
            parameters: { type: 'npc | location', name: 'Nome da verificare' },
            async run(args) {
                const type = String(args.type || '').toLowerCase();
                const raw = String(args.name || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
                const low = raw.toLowerCase();
                if (!raw) return { match: false, reason: 'empty' };

                if (type === 'npc') {
                    const exact = getNpcEntry(campaignId, raw);
                    if (exact) return { match: true, canonical: (exact as any).name, id: (exact as any).short_id, status: (exact as any).status };
                    const all = listNpcs(campaignId, 1000);
                    const hit = all.find((n: any) =>
                        n.name?.toLowerCase() === low ||
                        n.name?.toLowerCase().includes(low) || low.includes(n.name?.toLowerCase()) ||
                        (n.aliases && `,${n.aliases.toLowerCase()},`.includes(`,${low},`)));
                    return hit
                        ? { match: true, canonical: hit.name, id: hit.short_id, status: hit.status }
                        : { match: false, hint: 'NPC non trovato nei record della campagna.' };
                }
                if (type === 'location') {
                    const all = listAtlasEntries(campaignId, 1000);
                    const hit = all.find((l: any) => {
                        const full = `${l.macro_location} - ${l.micro_location}`.toLowerCase();
                        return full === low || full.includes(low) || low.includes((l.micro_location || '').toLowerCase());
                    });
                    return hit
                        ? { match: true, location_id: hit.short_id, macro: hit.macro_location, micro: hit.micro_location }
                        : { match: false, hint: 'Luogo non trovato nei record della campagna.' };
                }
                return { match: false, reason: 'type deve essere npc o location' };
            }
        },
        {
            name: 'search_historical_rag',
            description: 'Cerca nella memoria RAG storica della campagna, indicizzata dalle sessioni precedenti.',
            parameters: { query: 'Domanda o termini da cercare', limit: 'Numero massimo di frammenti, default 5' },
            async run(args) {
                const fragments = await searchKnowledge(campaignId, String(args.query || ''), asLimit(args.limit, 5, 8));
                return fragments.map(content => ({ content: content.substring(0, 1200) }));
            }
        },
        {
            name: 'get_last_session_recap',
            description: 'Restituisce il recap completo, in ordine cronologico, dell\'ultima sessione di gioco registrata.',
            parameters: {},
            async run() {
                const latestSessionId = getLatestSessionId(campaignId);
                if (!latestSessionId) return { found: false };
                const fragments = getFragmentsBySessionId(latestSessionId);
                if (fragments.length === 0) return { found: false };
                return {
                    found: true,
                    sessionNumber: getExplicitSessionNumber(latestSessionId),
                    content: fragments.map(f => f.content).join('\n').substring(0, 8000)
                };
            }
        }
    ];
}
