/**
 * World Manifesto - AI-compressed campaign context for Analyst
 *
 * Generates a dense "world manifesto" that gives the Analyst AI
 * a big-picture view of the campaign without saturating the context window.
 */

import { npcRepository } from '../db/repositories/NpcRepository';
import { factionRepository } from '../db/repositories/FactionRepository';
import { locationRepository } from '../db/repositories/LocationRepository';
import { artifactRepository } from '../db/repositories/ArtifactRepository';
import { questRepository } from '../db/repositories/QuestRepository';
import { campaignRepository } from '../db/repositories/CampaignRepository';
import { characterRepository } from '../db/repositories/CharacterRepository';
import { metadataClient, METADATA_MODEL, METADATA_PROVIDER } from './config';
import { monitor } from '../monitor';

// Cache in-memory per il manifesto (chiave: campaignId)
interface ManifestoCache {
    content: string;
    timestamp: number;
}

const manifestoCache: Record<number, ManifestoCache> = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 ora

/**
 * Genera il "World Manifesto" per una campagna, usando la cache se valida.
 */
export async function getOrCreateManifesto(campaignId: number): Promise<string> {
    const cached = manifestoCache[campaignId];
    const now = Date.now();

    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
        console.log(`[Manifesto] 💾 Cache hit per campagna ${campaignId}`);
        return cached.content;
    }

    console.log(`[Manifesto] 🔄 Generazione manifesto per campagna ${campaignId}...`);
    const manifesto = await generateWorldManifesto(campaignId);

    manifestoCache[campaignId] = {
        content: manifesto,
        timestamp: now
    };

    return manifesto;
}

/**
 * Invalida la cache del manifesto per una campagna.
 * Da chiamare dopo processBatchEvents o modifiche significative.
 */
export function invalidateManifesto(campaignId: number): void {
    if (manifestoCache[campaignId]) {
        console.log(`[Manifesto] 🗑️ Cache invalidata per campagna ${campaignId}`);
        delete manifestoCache[campaignId];
    }
}

/**
 * Verifica se esiste un manifesto in cache valido per la campagna.
 */
export function hasManifestoCache(campaignId: number): boolean {
    const cached = manifestoCache[campaignId];
    if (!cached) return false;
    return (Date.now() - cached.timestamp) < CACHE_TTL_MS;
}

/**
 * Genera il manifesto aggregando i dati e chiamando l'AI.
 */
async function generateWorldManifesto(campaignId: number): Promise<string> {
    const startTime = Date.now();

    try {
        // 1. Raccolta Dati
        const campaign = campaignRepository.getCampaignById(campaignId);
        if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

        const characters = characterRepository.getCampaignCharacters(campaignId);
        const partyFaction = factionRepository.getPartyFaction(campaignId);
        const factions = factionRepository.listFactions(campaignId, true);
        const npcs = npcRepository.getAllNpcs(campaignId);
        const artifacts = artifactRepository.listAllArtifacts(campaignId);
        const locations = locationRepository.listAllAtlasEntries(campaignId);
        const quests = questRepository.getOpenQuests(campaignId);

        // Arricchisci NPC con eventi recenti
        const npcsWithEvents = npcs.map((npc: any) => {
            const events = npcRepository.getNpcHistory(campaignId, npc.name);
            return { ...npc, events: events.slice(-5) }; // Ultimi 5 eventi
        });

        // Arricchisci fazioni con reputazione e membri
        const factionsWithRep = factions.map((f: any) => ({
            ...f,
            reputation: factionRepository.getFactionReputation(campaignId, f.id),
            members: factionRepository.countFactionMembers(f.id)
        }));

        // 2. Costruzione Context Raw
        const contextData = buildContextForArchivista({
            campaign,
            characters,
            partyFaction,
            factions: factionsWithRep,
            npcs: npcsWithEvents,
            artifacts,
            locations,
            quests
        });

        // 3. Compressione AI (Archivista)
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [
                { role: 'system', content: 'Sei un archivista esperto di campagne D&D. Compili manifesti operativi densi e informativi.' },
                { role: 'user', content: ARCHIVISTA_PROMPT(campaign.name, contextData) }
            ],
            temperature: 0.3,
            max_tokens: 6000
        });

        const manifesto = response.choices[0]?.message?.content || buildFallbackManifesto(contextData);
        const latency = Date.now() - startTime;

        // Monitoraggio Costi
        if (response.usage) {
            monitor.logAIRequestWithCost(
                'manifesto',
                METADATA_PROVIDER,
                METADATA_MODEL,
                response.usage.prompt_tokens,
                response.usage.completion_tokens,
                0, // cached tokens
                latency,
                false // not failed
            );
        }

        console.log(`[Manifesto] ✅ Generato (${manifesto.length} chars, ${response.usage?.total_tokens || 0} tokens, ${latency}ms)`);
        return manifesto;

    } catch (error: any) {
        console.error(`[Manifesto] ❌ Errore generazione:`, error.message);
        // In caso di errore, ritorna un manifesto vuoto piuttosto che fallire
        return '';
    }
}

/**
 * Formatta i dati grezzi per l'AI con tutti gli ID necessari
 */
function buildContextForArchivista(data: any): string {
    const { campaign, characters, partyFaction, factions, npcs, artifacts, locations, quests } = data;

    let ctx = '';

    // Party e PG
    ctx += `\n## PARTY: ${partyFaction?.name || 'Gruppo Senza Nome'} [ID: ${partyFaction?.short_id || 'N/A'}]\n`;
    for (const char of characters) {
        ctx += `- **${char.character_name}** [ID: ${char.short_id || 'N/A'}] (${char.race || ''} ${char.class || ''}): ${char.description || 'Nessuna descrizione'}\n`;
    }

    // NPC (top 30 per attività recente)
    const sortedNpcs = npcs
        .sort((a: any, b: any) => (b.events?.length || 0) - (a.events?.length || 0))
        .slice(0, 30);

    ctx += `\n## NPC (${npcs.length} totali, top 30)\n`;
    for (const npc of sortedNpcs) {
        ctx += `- **${npc.name}** [ID: ${npc.short_id}] (${npc.role || 'Sconosciuto'}) [${npc.status || 'ALIVE'}]: ${(npc.description || '').substring(0, 150)}\n`;
        if (npc.events?.length) {
            const recentEvents = npc.events.slice(-3).map((e: any) => `[${e.event_type}] ${(e.description || '').substring(0, 60)}`).join('; ');
            ctx += `  Eventi recenti: ${recentEvents}\n`;
        }
    }

    // Fazioni
    ctx += `\n## FAZIONI (${factions.length})\n`;
    for (const faction of factions) {
        const rep = faction.reputation || 'NEUTRALE';
        const memberCount = faction.members?.npcs || 0;
        ctx += `- **${faction.name}** [ID: ${faction.short_id}] (${faction.type}): ${(faction.description || '').substring(0, 100)} [Rep: ${rep}, Membri: ${memberCount} NPC]`;
        if (faction.is_party) ctx += ' [PARTY]';
        ctx += '\n';
    }

    // Artefatti
    ctx += `\n## ARTEFATTI (${artifacts.length})\n`;
    for (const art of artifacts) {
        let line = `- **${art.name}** [ID: ${art.short_id}]: ${(art.description || '').substring(0, 100)}`;
        if (art.is_cursed) line += ' [MALEDETTO]';
        if (art.owner_name) line += ` [Possessore: ${art.owner_name}]`;
        ctx += line + '\n';
    }

    // Luoghi (top 20)
    ctx += `\n## ATLANTE (${locations.length} luoghi, top 20)\n`;
    for (const loc of locations.slice(0, 20)) {
        ctx += `- **${loc.macro_location} - ${loc.micro_location}** [ID: ${loc.short_id}]: ${(loc.description || '').substring(0, 80)}\n`;
    }

    // Quest attive
    ctx += `\n## QUEST ATTIVE (${quests.length})\n`;
    for (const q of quests) {
        ctx += `- **${q.title}** [ID: ${q.short_id}] [${q.status}] [${q.type || 'MAJOR'}]: ${(q.description || '').substring(0, 100)}\n`;
    }

    return ctx;
}

/**
 * Fallback in caso di errore AI
 */
function buildFallbackManifesto(contextData: string): string {
    return `[[MANIFESTO CAMPAGNA - FALLBACK MODE]]\n${contextData.substring(0, 6000)}`;
}

/**
 * Prompt per l'Archivista AI
 */
const ARCHIVISTA_PROMPT = (campaignName: string, contextData: string) => `Sei l'ARCHIVISTA UFFICIALE della campagna D&D "${campaignName}".

Il tuo compito è compilare un MANIFESTO OPERATIVO che un'altra AI (l'Analista) userà per comprendere il contesto della campagna durante l'analisi di una sessione.

## DATI GREZZI DELLA CAMPAGNA:
${contextData}

## ISTRUZIONI CRITICHE:
1. **CONSERVA TUTTI GLI [ID: xxxxx]** - Sono CRITICI per il linking. L'Analista userà questi ID per collegare eventi a entità esistenti. SENZA ID = entità persa nel linking.
2. **PRIORITIZZA** le informazioni per rilevanza narrativa (conflitti attivi, relazioni importanti, minacce correnti).
3. **COMPRIMI** le descrizioni mantenendo i fatti essenziali e le relazioni tra entità.
4. **EVIDENZIA** relazioni tra entità (chi è alleato/nemico di chi, chi possiede cosa, chi controlla cosa).
5. **MASSIMO 5000 caratteri** di output.

## OUTPUT RICHIESTO (Formato strutturato):

### 🎭 PARTY E PROTAGONISTI
[Per ogni PG: Nome [ID], razza/classe, tratto distintivo, eventi chiave recenti]

### ⚔️ FAZIONI IN CONFLITTO
[Per ogni fazione rilevante: Nome [ID], obiettivo principale, reputazione col party, membri chiave con [ID]]

### 👥 NPC CHIAVE
[Top 15 NPC per importanza narrativa: Nome [ID], ruolo, status, relazione col party, eventi recenti significativi]

### ✨ ARTEFATTI SIGNIFICATIVI
[Nome [ID], effetto noto, proprietario attuale, maledizioni se presenti]

### 🗺️ GEOGRAFIA RILEVANTE
[Macro-location e luoghi chiave con [ID], importanza narrativa]

### 📜 ARCHI NARRATIVI APERTI
[Quest attive con [ID], stato attuale, prossimo obiettivo logico]

### ⚡ TENSIONI E MINACCE ATTUALI
[Conflitti in corso, nemici attivi, pericoli imminenti]

Scrivi in modo DENSO e INFORMATIVO. L'Analista deve capire rapidamente "chi è chi", "cosa sta succedendo" e "quali sono le dinamiche in gioco" leggendo questo manifesto.`;
