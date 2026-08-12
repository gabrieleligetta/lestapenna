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
import { getMetadataClient } from './config';
import { generateText } from './llm/generate';
import * as fs from 'fs';
import * as path from 'path';

// In-memory cache for the manifesto (key: campaignId)
interface ManifestoCache {
    content: string;
    timestamp: number;
}

const manifestoCache: Record<number, ManifestoCache> = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 ora

function persistentCachePath(campaignId: number): string {
    return path.join(process.cwd(), 'data', 'manifesto_cache', `campaign_${campaignId}.json`);
}

function readPersistentCache(campaignId: number, now: number): ManifestoCache | null {
    try {
        const filePath = persistentCachePath(campaignId);
        if (!fs.existsSync(filePath)) return null;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ManifestoCache;
        if (!parsed.content || !parsed.timestamp) return null;
        if (now - parsed.timestamp >= CACHE_TTL_MS) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writePersistentCache(campaignId: number, cache: ManifestoCache): void {
    try {
        const filePath = persistentCachePath(campaignId);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error: any) {
        console.warn(`[Manifesto] ⚠️ Cache persistente non salvata: ${error?.message || error}`);
    }
}

/**
 * Generates the "World Manifesto" for a campaign, using the cache when valid.
 */
export async function getOrCreateManifesto(campaignId: number): Promise<string> {
    const cached = manifestoCache[campaignId];
    const now = Date.now();

    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
        console.log(`[Manifesto] 💾 Cache hit per campagna ${campaignId}`);
        return cached.content;
    }

    const persistent = readPersistentCache(campaignId, now);
    if (persistent) {
        manifestoCache[campaignId] = persistent;
        console.log(`[Manifesto] 💾 Cache persistente hit per campagna ${campaignId}`);
        return persistent.content;
    }

    console.log(`[Manifesto] 🔄 Generazione manifesto per campagna ${campaignId}...`);
    const manifesto = await generateWorldManifesto(campaignId);

    manifestoCache[campaignId] = {
        content: manifesto,
        timestamp: now
    };
    writePersistentCache(campaignId, manifestoCache[campaignId]);

    return manifesto;
}

/**
 * Invalidates a campaign's manifesto cache.
 * To be called after processBatchEvents or significant changes.
 */
export function invalidateManifesto(campaignId: number): void {
    if (manifestoCache[campaignId]) {
        console.log(`[Manifesto] 🗑️ Cache invalidata per campagna ${campaignId}`);
        delete manifestoCache[campaignId];
    }
    try {
        const filePath = persistentCachePath(campaignId);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
}

/**
 * Checks whether a valid cached manifesto exists for the campaign.
 */
export function hasManifestoCache(campaignId: number): boolean {
    const cached = manifestoCache[campaignId];
    if (!cached) return false;
    return (Date.now() - cached.timestamp) < CACHE_TTL_MS;
}

/**
 * Generates the manifesto by aggregating the data and calling the AI.
 */
async function generateWorldManifesto(campaignId: number): Promise<string> {
    const startTime = Date.now();

    try {
        // 1. Data gathering
        const campaign = campaignRepository.getCampaignById(campaignId);
        if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

        const characters = characterRepository.getCampaignCharacters(campaignId);
        const partyFaction = factionRepository.getPartyFaction(campaignId);
        const factions = factionRepository.listFactions(campaignId, true);
        const npcs = npcRepository.getAllNpcs(campaignId);
        const artifacts = artifactRepository.listAllArtifacts(campaignId);
        const locations = locationRepository.listAllAtlasEntries(campaignId);
        const quests = questRepository.getOpenQuests(campaignId);

        // Enrich NPCs with ALL the events (not just the last 5)
        const npcsWithEvents = npcs.map((npc: any) => {
            const events = npcRepository.getNpcHistory(campaignId, npc.name);
            return { ...npc, events }; // Every event
        });

        // Enrich factions with reputation, members and history
        const factionsWithRep = factions.map((f: any) => {
            const events = factionRepository.getFactionHistory(campaignId, f.name);
            return {
                ...f,
                reputation: factionRepository.getFactionReputation(campaignId, f.id),
                members: factionRepository.countFactionMembers(f.id),
                events: events.slice(-5) // The last 5 events per faction
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
        const ai = await generateText({
            route: await getMetadataClient(),
            label: 'manifesto',
            system: 'You are an expert D&D campaign archivist. You compile dense, informative operational manifestos.',
            prompt: ARCHIVISTA_PROMPT(campaign.name, contextData),
            temperature: 1,
            maxTokens: 10000
        });
        const manifesto = ai.content || buildFallbackManifesto(contextData);

        console.log(`[Manifesto] ✅ Generato (${manifesto.length} chars, ${ai.usage.input + ai.usage.output} tokens, ${ai.latencyMs}ms)`);
        return manifesto;

    } catch (error: any) {
        console.error(`[Manifesto] ❌ Errore generazione:`, error.message);
        // On error, return an empty manifesto rather than failing
        return '';
    }
}

/**
 * Formats the raw data for the AI with every id it needs
 * NOTE: No artificial limit - it passes ALL the available context
 */
function buildContextForArchivista(data: any): string {
    const { campaign, characters, partyFaction, factions, npcs, artifacts, locations, quests } = data;

    let ctx = '';

    // ============================================
    // PARTY E PG (COMPLETO)
    // ============================================
    ctx += `\n## PARTY: ${partyFaction?.name || 'Unnamed Group'} [ID: ${partyFaction?.short_id || 'N/A'}]\n`;
    if (partyFaction?.description) {
        ctx += `Description: ${partyFaction.description}\n`;
    }
    ctx += `\n### Party Members:\n`;
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
    // FACTIONS (COMPLETE, WITH DETAILS)
    // ============================================
    ctx += `\n## FACTIONS (${factions.length} total)\n`;
    for (const faction of factions) {
        const rep = faction.reputation || 'NEUTRAL';
        const memberCount = faction.members?.npcs || 0;
        const locCount = faction.members?.locations || 0;

        ctx += `\n### ${faction.name} [ID: ${faction.short_id}]`;
        if (faction.is_party) ctx += ' ⭐ PARTY';
        ctx += `\n`;
        ctx += `- Type: ${faction.type || 'GENERIC'} | Reputation: ${rep} | Members: ${memberCount} NPCs, ${locCount} Locations\n`;
        if (faction.alignment_moral || faction.alignment_ethical) {
            ctx += `- Alignment: ${faction.alignment_ethical || ''} ${faction.alignment_moral || ''}\n`;
        }
        if (faction.description) {
            ctx += `- Description: ${faction.description}\n`;
        }
        // The faction's recent events
        if (faction.events?.length) {
            const recentEvents = faction.events.slice(-3).map((e: any) => `[${e.event_type}] ${e.description}`).join('; ');
            ctx += `- Recent events: ${recentEvents}\n`;
        }
    }

    // ============================================
    // NPCS (ALL OF THEM, ORDERED BY RELEVANCE)
    // ============================================
    // Ordered by: 1) number of events, 2) last update date
    const sortedNpcs = npcs.sort((a: any, b: any) => {
        const eventsA = a.events?.length || 0;
        const eventsB = b.events?.length || 0;
        if (eventsB !== eventsA) return eventsB - eventsA;
        return new Date(b.last_updated || 0).getTime() - new Date(a.last_updated || 0).getTime();
    });

    ctx += `\n## KNOWN NPCS (${npcs.length} total)\n`;

    // The most relevant first (with events)
    const activeNpcs = sortedNpcs.filter((n: any) => n.events?.length > 0);
    const passiveNpcs = sortedNpcs.filter((n: any) => !n.events?.length);

    if (activeNpcs.length > 0) {
        ctx += `\n### Active NPCs (with history):\n`;
        for (const npc of activeNpcs) {
            ctx += `- **${npc.name}** [ID: ${npc.short_id}] (${npc.role || 'Unknown'}) [${npc.status || 'ALIVE'}]`;
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
                ctx += `  History (${npc.events.length} events):\n`;
                // Show the last 5 events for active NPCs
                for (const e of npc.events.slice(-5)) {
                    ctx += `    • [${e.event_type}] ${e.description}\n`;
                }
            }
        }
    }

    if (passiveNpcs.length > 0) {
        ctx += `\n### Other known NPCs:\n`;
        for (const npc of passiveNpcs) {
            ctx += `- **${npc.name}** [ID: ${npc.short_id}] (${npc.role || 'Unknown'}) [${npc.status || 'ALIVE'}]`;
            if (npc.last_seen_location) {
                ctx += ` 📍${npc.last_seen_location}`;
            }
            ctx += `: ${npc.description || 'No description'}\n`;
        }
    }

    // ============================================
    // ARTIFACTS (ALL, WITH DETAILS)
    // ============================================
    if (artifacts.length > 0) {
        ctx += `\n## ARTIFACTS (${artifacts.length})\n`;
        for (const art of artifacts) {
            ctx += `- **${art.name}** [ID: ${art.short_id}] [${art.status || 'FUNCTIONAL'}]`;
            if (art.is_cursed) ctx += ' ⚠️CURSED';
            ctx += `\n`;
            if (art.description) {
                ctx += `  Description: ${art.description}\n`;
            }
            if (art.effects) {
                ctx += `  Effects: ${art.effects}\n`;
            }
            if (art.owner_name) {
                ctx += `  Owner: ${art.owner_name} (${art.owner_type || 'NPC'})\n`;
            }
            if (art.location_macro || art.location_micro) {
                ctx += `  Location: ${art.location_macro || ''} - ${art.location_micro || ''}\n`;
            }
            if (art.curse_description) {
                ctx += `  Curse: ${art.curse_description}\n`;
            }
        }
    }

    // ============================================
    // ATLAS (EVERY LOCATION)
    // ============================================
    ctx += `\n## ATLAS (${locations.length} places)\n`;

    // Raggruppa per macro-location
    const locationsByMacro: Record<string, any[]> = {};
    for (const loc of locations) {
        const macro = loc.macro_location || 'Unknown';
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
    // QUESTS (ALL, WITH DETAILS)
    // ============================================
    ctx += `\n## ACTIVE QUESTS (${quests.length})\n`;
    for (const q of quests) {
        ctx += `- **${q.title}** [ID: ${q.short_id}] [${q.status}] [${q.type || 'MAJOR'}]\n`;
        if (q.description) {
            ctx += `  Description: ${q.description}\n`;
        }
        if (q.giver_npc) {
            ctx += `  Quest Giver: ${q.giver_npc}\n`;
        }
    }

    return ctx;
}

/**
 * Fallback on an AI error
 */
function buildFallbackManifesto(contextData: string): string {
    return `[[CAMPAIGN MANIFESTO - FALLBACK MODE]]\n${contextData.substring(0, 6000)}`;
}

/** Prompt for the AI Archivist */
const ARCHIVISTA_PROMPT = (campaignName: string, contextData: string) => `You are the OFFICIAL ARCHIVIST of the D&D campaign "${campaignName}".

Your task is to compile an OPERATIONAL MANIFESTO that another AI (the Analyst) will use to understand the campaign's context while analyzing a session.

## RAW CAMPAIGN DATA:
${contextData}

## CRITICAL INSTRUCTIONS:
1. **PRESERVE ALL [ID: xxxxx]** - They are CRITICAL for linking. The Analyst will use these IDs to link events to existing entities. NO ID = entity lost in linking.
2. **PRIORITIZE** information by narrative relevance (active conflicts, important relationships, current threats).
3. **COMPRESS** descriptions while keeping the essential facts and the relationships between entities.
4. **HIGHLIGHT** relationships between entities (who is allied/enemy of whom, who owns what, who controls what).
5. **MAXIMUM 5000 characters** of output.

## REQUIRED OUTPUT (Structured format):

### 🎭 PARTY AND PROTAGONISTS
[For each PC: Name [ID], race/class, distinctive trait, recent key events]

### ⚔️ FACTIONS IN CONFLICT
[For each relevant faction: Name [ID], main goal, reputation with the party, key members with [ID]]

### 👥 KEY NPCS
[Top 15 NPCs by narrative importance: Name [ID], role, status, relationship with the party, significant recent events]

### ✨ SIGNIFICANT ARTIFACTS
[Name [ID], known effect, current owner, curses if any]

### 🗺️ RELEVANT GEOGRAPHY
[Macro-locations and key places with [ID], narrative importance]

### 📜 OPEN NARRATIVE ARCS
[Active quests with [ID], current state, next logical objective]

### ⚡ CURRENT TENSIONS AND THREATS
[Ongoing conflicts, active enemies, imminent dangers]

Write in a DENSE, INFORMATIVE way. The Analyst must quickly understand "who is who", "what is happening" and "what dynamics are in play" by reading this manifesto.`;
