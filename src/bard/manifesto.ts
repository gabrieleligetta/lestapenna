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

        // Arricchisci NPC con TUTTI gli eventi (non solo ultimi 5)
        const npcsWithEvents = npcs.map((npc: any) => {
            const events = npcRepository.getNpcHistory(campaignId, npc.name);
            return { ...npc, events }; // Tutti gli eventi
        });

        // Arricchisci fazioni con reputazione, membri e storia
        const factionsWithRep = factions.map((f: any) => {
            const events = factionRepository.getFactionHistory(campaignId, f.name);
            return {
                ...f,
                reputation: factionRepository.getFactionReputation(campaignId, f.id),
                members: factionRepository.countFactionMembers(f.id),
                events: events.slice(-5) // Ultimi 5 eventi per fazione
            };
        });

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
            temperature: 1,
            max_completion_tokens: 10000
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
 * NOTA: Nessun limite artificiale - passa TUTTO il contesto disponibile
 */
function buildContextForArchivista(data: any): string {
    const { campaign, characters, partyFaction, factions, npcs, artifacts, locations, quests } = data;

    let ctx = '';

    // ============================================
    // PARTY E PG (COMPLETO)
    // ============================================
    ctx += `\n## PARTY: ${partyFaction?.name || 'Gruppo Senza Nome'} [ID: ${partyFaction?.short_id || 'N/A'}]\n`;
    if (partyFaction?.description) {
        ctx += `Descrizione: ${partyFaction.description}\n`;
    }
    ctx += `\n### Membri del Party:\n`;
    for (const char of characters) {
        ctx += `- **${char.character_name}** [ID: ${char.short_id || 'N/A'}] (${char.race || ''} ${char.class || ''})`;
        if (char.alignment_moral || char.alignment_ethical) {
            ctx += ` [${char.alignment_ethical || ''} ${char.alignment_moral || ''}]`;
        }
        ctx += `\n`;
        if (char.description) {
            ctx += `  Bio: ${char.description}\n`;
        }
    }

    // ============================================
    // FAZIONI (COMPLETO CON DETTAGLI)
    // ============================================
    ctx += `\n## FAZIONI (${factions.length} totali)\n`;
    for (const faction of factions) {
        const rep = faction.reputation || 'NEUTRAL';
        const memberCount = faction.members?.npcs || 0;
        const locCount = faction.members?.locations || 0;

        ctx += `\n### ${faction.name} [ID: ${faction.short_id}]`;
        if (faction.is_party) ctx += ' ⭐ PARTY';
        ctx += `\n`;
        ctx += `- Tipo: ${faction.type || 'GENERIC'} | Reputazione: ${rep} | Membri: ${memberCount} NPC, ${locCount} Luoghi\n`;
        if (faction.alignment_moral || faction.alignment_ethical) {
            ctx += `- Allineamento: ${faction.alignment_ethical || ''} ${faction.alignment_moral || ''}\n`;
        }
        if (faction.description) {
            ctx += `- Descrizione: ${faction.description}\n`;
        }
        // Eventi recenti della fazione
        if (faction.events?.length) {
            const recentEvents = faction.events.slice(-3).map((e: any) => `[${e.event_type}] ${e.description}`).join('; ');
            ctx += `- Eventi recenti: ${recentEvents}\n`;
        }
    }

    // ============================================
    // NPC (TUTTI, ORDINATI PER RILEVANZA)
    // ============================================
    // Ordina per: 1) numero eventi, 2) data ultimo aggiornamento
    const sortedNpcs = npcs.sort((a: any, b: any) => {
        const eventsA = a.events?.length || 0;
        const eventsB = b.events?.length || 0;
        if (eventsB !== eventsA) return eventsB - eventsA;
        return new Date(b.last_updated || 0).getTime() - new Date(a.last_updated || 0).getTime();
    });

    ctx += `\n## NPC CONOSCIUTI (${npcs.length} totali)\n`;

    // Prima i più rilevanti (con eventi)
    const activeNpcs = sortedNpcs.filter((n: any) => n.events?.length > 0);
    const passiveNpcs = sortedNpcs.filter((n: any) => !n.events?.length);

    if (activeNpcs.length > 0) {
        ctx += `\n### NPC Attivi (con storia):\n`;
        for (const npc of activeNpcs) {
            ctx += `- **${npc.name}** [ID: ${npc.short_id}] (${npc.role || 'Sconosciuto'}) [${npc.status || 'ALIVE'}]`;
            if (npc.alignment_moral || npc.alignment_ethical) {
                ctx += ` [${npc.alignment_ethical || ''} ${npc.alignment_moral || ''}]`;
            }
            if (npc.last_seen_location) {
                ctx += ` 📍${npc.last_seen_location}`;
            }
            ctx += `\n`;
            if (npc.description) {
                ctx += `  Bio: ${npc.description}\n`;
            }
            if (npc.events?.length) {
                ctx += `  Storia (${npc.events.length} eventi):\n`;
                // Mostra ultimi 5 eventi per NPC attivi
                for (const e of npc.events.slice(-5)) {
                    ctx += `    • [${e.event_type}] ${e.description}\n`;
                }
            }
        }
    }

    if (passiveNpcs.length > 0) {
        ctx += `\n### Altri NPC noti:\n`;
        for (const npc of passiveNpcs) {
            ctx += `- **${npc.name}** [ID: ${npc.short_id}] (${npc.role || 'Sconosciuto'}) [${npc.status || 'ALIVE'}]`;
            if (npc.last_seen_location) {
                ctx += ` 📍${npc.last_seen_location}`;
            }
            ctx += `: ${npc.description || 'Nessuna descrizione'}\n`;
        }
    }

    // ============================================
    // ARTEFATTI (TUTTI CON DETTAGLI)
    // ============================================
    if (artifacts.length > 0) {
        ctx += `\n## ARTEFATTI (${artifacts.length})\n`;
        for (const art of artifacts) {
            ctx += `- **${art.name}** [ID: ${art.short_id}] [${art.status || 'FUNCTIONAL'}]`;
            if (art.is_cursed) ctx += ' ⚠️MALEDETTO';
            ctx += `\n`;
            if (art.description) {
                ctx += `  Descrizione: ${art.description}\n`;
            }
            if (art.effects) {
                ctx += `  Effetti: ${art.effects}\n`;
            }
            if (art.owner_name) {
                ctx += `  Possessore: ${art.owner_name} (${art.owner_type || 'NPC'})\n`;
            }
            if (art.location_macro || art.location_micro) {
                ctx += `  Ubicazione: ${art.location_macro || ''} - ${art.location_micro || ''}\n`;
            }
            if (art.curse_description) {
                ctx += `  Maledizione: ${art.curse_description}\n`;
            }
        }
    }

    // ============================================
    // ATLANTE (TUTTI I LUOGHI)
    // ============================================
    ctx += `\n## ATLANTE (${locations.length} luoghi)\n`;

    // Raggruppa per macro-location
    const locationsByMacro: Record<string, any[]> = {};
    for (const loc of locations) {
        const macro = loc.macro_location || 'Sconosciuto';
        if (!locationsByMacro[macro]) locationsByMacro[macro] = [];
        locationsByMacro[macro].push(loc);
    }

    for (const [macro, locs] of Object.entries(locationsByMacro)) {
        ctx += `\n### ${macro}\n`;
        for (const loc of locs) {
            ctx += `- **${loc.micro_location}** [ID: ${loc.short_id}]`;
            if (loc.description) {
                ctx += `: ${loc.description}`;
            }
            ctx += `\n`;
        }
    }

    // ============================================
    // QUEST (TUTTE CON DETTAGLI)
    // ============================================
    ctx += `\n## QUEST ATTIVE (${quests.length})\n`;
    for (const q of quests) {
        ctx += `- **${q.title}** [ID: ${q.short_id}] [${q.status}] [${q.type || 'MAJOR'}]\n`;
        if (q.description) {
            ctx += `  Descrizione: ${q.description}\n`;
        }
        if (q.giver_npc) {
            ctx += `  Quest Giver: ${q.giver_npc}\n`;
        }
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
