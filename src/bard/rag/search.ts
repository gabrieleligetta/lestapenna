/**
 * Bard RAG Search - Search and retrieval functions
 */

import {
    getKnowledgeFragments,
    getFragmentsBySessionId,
    getLatestSessionId,
    knowledgeRepository,
    aiUsageRepository,
    listNpcs,
    createEntityRef,
    filterEntityRefsByType,
    parseEntityRefs,
    migrateOldNpcIds,
    getCampaignLocationById,
    getCampaignById,
    findNpcDossierByName,
    getExplicitSessionNumber,
    tenantRepository,
} from '../../db';
import {
    getChatClient
} from '../config';
import { cosineSimilarity, withRetry } from '../helpers';
import { generateJson } from '../llm/generate';
import { embedText } from '../llm/embeddings';
import { scopeForCampaign } from '../ai/scope';
import { campaignEmbeddingModel } from '../ai/embeddings';
import { resolvePricing, calculateCost } from '../../monitor/costs';
import type { AiUsageLogInput } from '../../db/repositories/AiUsageRepository';
import { RAG_QUERY_GENERATION_PROMPT, BARD_AGENTIC_PROMPT } from '../prompts';
import { aiOutputDirective, getCampaignLocale, t } from '../../i18n';
import { runAgent } from '../agent/runtime';
import { createBardoTools } from '../agent/tools';
import { ASK_OUTPUT_SCHEMA } from '../agent/outputSchemas';
import {
    buildEuroCostSnapshot,
    getUsdEurRate,
    type UsdEurRate,
} from '../../services/aiCostTransparency';

/**
 * Builds the cost row for an askBard LLM/agent call, so the cost of EVERY $ask
 * exchange is tracked in `ai_usage_log` right away (not only at the end of a
 * recording session, where `Monitor` normally does not run — $ask goes through
 * no admission gate). Local providers (ollama) have no monetary cost: no row
 * for them.
 */
function buildAskCostEntry(
    phase: string,
    provider: string,
    model: string,
    usage: { input: number; output: number; cached?: number }
): AiUsageLogInput | null {
    const isBilledProvider = provider === 'openai' || provider === 'gemini' || provider === 'anthropic';
    if (!isBilledProvider) return null;

    const pricing = resolvePricing(model);
    const costUSD = calculateCost(model, usage.input, usage.output, usage.cached);

    return {
        phase,
        provider,
        model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedInputTokens: usage.cached,
        inputPricePerMillion: pricing?.input,
        outputPricePerMillion: pricing?.output,
        cachedInputPricePerMillion: pricing?.cachedInput,
        costUSD,
    };
}

// ─── PER-CAMPAIGN VECTOR CACHE ───────────────────────────────────────────────
// Parsing embedding_json (TEXT) over ALL the fragments was the dominant cost
// of every search — and askBard fires N searches in parallel. The parsed vectors
// (Float32Array) are cached per campaign and invalidated by the repository's
// version counter; the TTL is only a backstop for the raw mutations that do
// not go through the repository (e.g. purgeSessionData).
const VECTOR_CACHE_TTL_MS = 5 * 60_000;

interface CachedFragment {
    id: number;
    session_id: string | null;
    content: string;
    macro_location: string | null;
    micro_location: string | null;
    associated_npcs: string | null;
    associated_npc_ids: string | null;
    associated_entity_ids: string | null;
    vector: Float32Array;
}

const _fragmentCache = new Map<number, { version: number; ts: number; fragments: CachedFragment[] }>();

function getCampaignVectors(campaignId: number): CachedFragment[] {
    const version = knowledgeRepository.getKnowledgeVersion();
    const cached = _fragmentCache.get(campaignId);
    if (cached && cached.version === version && Date.now() - cached.ts < VECTOR_CACHE_TTL_MS) {
        return cached.fragments;
    }

    // The campaign's model, not a fixed one: filtering on the wrong model
    // would return zero fragments and an apparently empty RAG.
    const model = campaignEmbeddingModel(campaignId);
    const rows = getKnowledgeFragments(campaignId, model); // ORDER BY id = ordine chunk
    const fragments: CachedFragment[] = [];
    for (const f of rows) {
        try {
            const vector = decodeFragmentVector(f);
            if (!vector) continue;
            fragments.push({
                id: (f as any).id,
                session_id: f.session_id,
                content: f.content,
                macro_location: f.macro_location ?? null,
                micro_location: f.micro_location ?? null,
                associated_npcs: f.associated_npcs ?? null,
                associated_npc_ids: (f as any).associated_npc_ids,
                associated_entity_ids: (f as any).associated_entity_ids,
                vector
            });
        } catch { /* frammento malformato: skip */ }
    }

    _fragmentCache.set(campaignId, { version, ts: Date.now(), fragments });
    return fragments;
}

/**
 * Decodes a fragment's vector: BLOB (raw Float32) when present, falling back to
 * embedding_json for the rows not backfilled yet.
 * ⚠️ better-sqlite3's Buffer lives in a pool with an arbitrary byteOffset
 * (not guaranteed to be 4-aligned): a copy is ALWAYS needed, never a view.
 */
export function decodeFragmentVector(f: { embedding_json: string; embedding?: Buffer | null }): Float32Array | null {
    const blob = f.embedding;
    if (blob && blob.length > 0 && blob.length % 4 === 0) {
        const copy = Uint8Array.prototype.slice.call(blob) as Uint8Array;
        return new Float32Array(copy.buffer, 0, copy.length / 4);
    }
    const parsed = JSON.parse(f.embedding_json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return Float32Array.from(parsed);
}

/** Sentinel session_id for the "always up to date" snapshots (not real game sessions). */
const UPDATE_SNAPSHOT_SESSION_IDS = new Set(['DOSSIER_UPDATE', 'ATLAS_UPDATE', 'INVENTORY_UPDATE']);

// A light cache to avoid one query per fragment when several fragments share
// the same real session (common, given the expansion to adjacent chunks).
const _sessionNumberCache = new Map<string, number | null>();
function lookupSessionNumber(sessionId: string): number | null {
    if (!_sessionNumberCache.has(sessionId)) {
        _sessionNumberCache.set(sessionId, getExplicitSessionNumber(sessionId));
    }
    return _sessionNumberCache.get(sessionId)!;
}

/**
 * Prefixes the content with a provenance/recency label, so the LLM can tell
 * which fragment is more recent (or is an always up-to-date snapshot) when two
 * fragments about the same entity contradict each other — e.g. an NPC described
 * as an ally in an old session and as a traitor in a more recent one, or in its
 * official card.
 */
function labelFragment(f: { session_id: string | null; content: string }): string {
    if (!f.session_id) return f.content;

    if (UPDATE_SNAPSHOT_SESSION_IDS.has(f.session_id)) {
        return `[RECORD UFFICIALE SEMPRE AGGIORNATO — ha priorità su qualsiasi sessione passata]\n${f.content}`;
    }

    const sessionNumber = lookupSessionNumber(f.session_id);
    if (sessionNumber !== null) {
        return `[Sessione #${sessionNumber}]\n${f.content}`;
    }

    return f.content;
}

/**
 * Searches the knowledge base (RAG)
 */
export async function searchKnowledge(campaignId: number, query: string, limit: number = 5): Promise<string[]> {
    try {
        // The question is embedded with the SAME model as the fragments, or the
        // cosine would compare different spaces and the scores would mean
        // nothing — with nothing flagging it.
        const queryVector = await embedText(query, scopeForCampaign(campaignId));

        // allFragments stays the COMPLETE array in chunk order: it is needed for the
        // expansion to the real neighbours. The NPC filter only produces the candidate list to score.
        const allFragments = getCampaignVectors(campaignId);
        if (allFragments.length === 0) return [];
        let fragments = allFragments;

        const allNpcs = listNpcs(campaignId, 1000);
        const mentionedEntityRefs: string[] = [];

        const queryLower = query.toLowerCase();
        for (const npc of allNpcs) {
            const npcLower = npc.name.toLowerCase();
            // Full name match
            if (queryLower.includes(npcLower)) {
                mentionedEntityRefs.push(createEntityRef('npc', npc.id));
                continue;
            }
            // Partial match: any significant word (4+ chars) of the NPC name appears in the query
            const npcWords = npcLower.split(/\s+/).filter(w => w.length >= 4);
            if (npcWords.some(word => queryLower.includes(word))) {
                mentionedEntityRefs.push(createEntityRef('npc', npc.id));
                continue;
            }
            if (npc.aliases) {
                const aliases = npc.aliases.split(',').map(a => a.trim().toLowerCase());
                if (aliases.some(alias => queryLower.includes(alias))) {
                    mentionedEntityRefs.push(createEntityRef('npc', npc.id));
                }
            }
        }

        if (mentionedEntityRefs.length > 0) {
            const mentionedNpcIds = filterEntityRefsByType(
                parseEntityRefs(mentionedEntityRefs.join(',')),
                'npc'
            );

            const filteredFragments = fragments.filter(f => {
                if (f.associated_entity_ids) {
                    const fragmentRefs = parseEntityRefs(f.associated_entity_ids);
                    const fragmentNpcIds = filterEntityRefsByType(fragmentRefs, 'npc');
                    if (mentionedNpcIds.some(qId => fragmentNpcIds.includes(qId))) return true;
                }
                if (f.associated_npc_ids) {
                    const migratedRefs = migrateOldNpcIds(f.associated_npc_ids);
                    if (migratedRefs) {
                        const fragmentRefs = parseEntityRefs(migratedRefs);
                        const fragmentNpcIds = filterEntityRefsByType(fragmentRefs, 'npc');
                        if (mentionedNpcIds.some(qId => fragmentNpcIds.includes(qId))) return true;
                    }
                }
                if (f.associated_npcs) {
                    let parsedNpcs: string[];
                    try {
                        parsedNpcs = JSON.parse(f.associated_npcs).map((n: string) => n.toLowerCase());
                    } catch {
                        parsedNpcs = f.associated_npcs.split(',').map(n => n.toLowerCase().trim());
                    }
                    const mentionedNpcs = allNpcs.filter(npc => mentionedNpcIds.includes(npc.id));
                    return mentionedNpcs.some(mn => parsedNpcs.includes(mn.name.toLowerCase()));
                }
                return false;
            });

            if (filteredFragments.length > 0) {
                fragments = filteredFragments;
            }
        }

        const currentLocation = getCampaignLocationById(campaignId);
        const currentMacro = currentLocation?.macro || "";
        const currentMicro = currentLocation?.micro || "";

        const queryLower2 = query.toLowerCase();
        const queryTokens = queryLower2.split(/\W+/).filter(w => w.length >= 4);

        const scored = fragments.map((f) => {
            let score = cosineSimilarity(queryVector, f.vector);

            if (currentMacro && f.macro_location === currentMacro) score += 0.05;
            if (currentMicro && f.micro_location === currentMicro) score += 0.10;

            // SMALL keyword boost: the old +0.5 on a substring of the whole query
            // dominated the cosine (~[0..1]) and fired almost only on short queries.
            // Now: +0.15 for an exact match, otherwise +0.03 per token (cap 0.12).
            const contentLower = f.content.toLowerCase();
            if (query.length > 2 && contentLower.includes(queryLower2)) {
                score += 0.15;
            } else if (queryTokens.length > 0) {
                const hits = queryTokens.filter(t => contentLower.includes(t)).length;
                score += Math.min(0.12, hits * 0.03);
            }

            return { fragment: f, score };
        });

        scored.sort((a, b) => b.score - a.score);

        // Expansion to the REAL ADJACENT chunks: the indexes are on allFragments
        // (ordered by id = the chunks' insertion order), not on the filtered
        // array — the neighbour of a filtered result is its true neighbour.
        const indexById = new Map(allFragments.map((f, i) => [f.id, i]));
        const topK = scored.slice(0, limit);
        const finalIndices = new Set<number>();

        topK.forEach(({ fragment }) => {
            const idx = indexById.get(fragment.id)!;
            finalIndices.add(idx);
            const prev = allFragments[idx - 1];
            if (prev && prev.session_id === fragment.session_id) finalIndices.add(idx - 1);
            const next = allFragments[idx + 1];
            if (next && next.session_id === fragment.session_id) finalIndices.add(idx + 1);
        });

        const finalFragments = Array.from(finalIndices)
            .sort((a, b) => a - b)
            .map(idx => labelFragment(allFragments[idx]));

        return finalFragments;

    } catch (e) {
        console.error("[RAG] ❌ Errore ricerca:", e);
        return [];
    }
}

export interface SearchQueriesResult {
    queries: string[];
    /** true when the question asks for a recap of the whole last session (see askBard). */
    wantsLastSessionRecap: boolean;
    /** Cost of this call, null when it failed or the provider is local. */
    costEntry: AiUsageLogInput | null;
}

/**
 * Generates search queries for the RAG agent
 */
export async function generateSearchQueries(campaignId: number, userQuestion: string, history: any[]): Promise<SearchQueriesResult> {
    const recentHistory = history.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');

    const prompt = RAG_QUERY_GENERATION_PROMPT(recentHistory, userQuestion);

    try {
        const ai = await generateJson({
            route: await getChatClient(),
            label: 'chat',
            system: 'Generate search queries for a D&D campaign RAG archive. Answer ONLY with JSON.',
            prompt
        });

        const costEntry = buildAskCostEntry('ask_query_generation', ai.provider, ai.model, ai.usage);
        const parsed: any = ai.parsed || {};
        // Handles both a plain array ["q1","q2"] (legacy format) and a structured object
        if (Array.isArray(parsed)) return { queries: parsed, wantsLastSessionRecap: false, costEntry };
        return {
            queries: Array.isArray(parsed.queries) ? parsed.queries : [],
            wantsLastSessionRecap: parsed.wantsLastSessionRecap === true,
            costEntry
        };
    } catch (e) {
        console.warn('[AskBard] ⚠️ Generazione query fallita, uso la domanda diretta:', (e as Error).message);
        return { queries: [userQuestion], wantsLastSessionRecap: false, costEntry: null };
    }
}

/**
 * Ask Bard (Agentic RAG)
 */
export interface AskBardResult {
    answer: string;
    /**
     * Whether the whole answer is held in the campaign's records.
     *
     * Reported rather than inferred: it is the model's own declaration, and the
     * only reason it can make one is that the output schema has a field for it.
     * Null when the exchange failed before an answer existed.
     */
    grounded: boolean | null;
    /**
     * What the question asked for and the records do not contain.
     *
     * The useful half of a refusal — «the appearance is not recorded» tells the
     * table what to write down, where a bare "I don't know" tells them nothing.
     */
    missing: string[];
    /** Real cost ($) of THIS exchange. $ask goes through no admission gate:
     *  it is persisted to ai_usage_log immediately (session_id "ASK"), not
     *  only at the end of a recording session like the rest of the bot. */
    costUsd: number;
    costEur: number | null;
    /** False when the answer provider failed and the returned text is only a fallback. */
    succeeded: boolean;
}

export async function askBard(campaignId: number, question: string, history: { role: 'user' | 'assistant', content: string }[] = []): Promise<AskBardResult> {
    const costEntries: AiUsageLogInput[] = [];

    const { queries: searchQueries, wantsLastSessionRecap, costEntry: queryGenCostEntry } = await generateSearchQueries(campaignId, question, history);
    if (queryGenCostEntry) costEntries.push(queryGenCostEntry);
    console.log(`[AskBard] 🧠 Query generate:`, searchQueries, wantsLastSessionRecap ? '(+ recap ultima sessione)' : '');

    const promises = searchQueries.map(q => searchKnowledge(campaignId, q, 3));
    const settled = await Promise.allSettled(promises);
    const results = settled
        .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
        .map(r => r.value);
    const uniqueContext = Array.from(new Set(results.flat()));

    // "What happened last session?": top-K by semantic similarity
    // only takes the chunks most similar to the question and can skip whole
    // parts of the session (e.g. the beginning or the end) — for this kind of
    // question the COMPLETE recap of the last session is needed, not just the
    // fragments that match best.
    let recapText = '';
    if (wantsLastSessionRecap) {
        const latestSessionId = getLatestSessionId(campaignId);
        if (latestSessionId) {
            const sessionFragments = getFragmentsBySessionId(latestSessionId);
            if (sessionFragments.length > 0) {
                const sessionNumber = getExplicitSessionNumber(latestSessionId);
                recapText = `\n\nFULL RECAP OF THE MOST RECENT SESSION${sessionNumber !== null ? ` (#${sessionNumber})` : ''} — use this as the primary source for "what happened" style questions, in full chronological order:\n`
                    + sessionFragments.map(f => f.content).join('\n');
            }
        }
    }

    let memoriesText = uniqueContext.length > 0
        ? "RETRIEVED MEMORIES (each labeled with its session number, or marked as an always-current official record — if two fragments about the same character/place/event conflict, trust the higher session number, or the official record over any session):\n"
            + uniqueContext.map(c => `...\\n${c}\\n...`).join("\\n")
        : "No specific memory found.";

    // The recap (when requested) is the primary source for this question — it must
    // NEVER be the one truncated for length: everything else is trimmed instead.
    const MAX_CONTEXT_CHARS = 12000;
    const memoriesBudget = Math.max(0, MAX_CONTEXT_CHARS - recapText.length);
    if (memoriesText.length > memoriesBudget) {
        memoriesText = memoriesText.substring(0, memoriesBudget) + "\n... [TEXT TRUNCATED]";
    }

    const contextText = memoriesText + recapText;

    const loc = getCampaignLocationById(campaignId);
    let atmosphere = "You are the campaign's Bard. Answer in a neutral but evocative way.";

    if (loc) {
        const micro = (loc.micro || "").toLowerCase();
        const macro = (loc.macro || "").toLowerCase();

        const hasAny = (s: string, words: string[]) => words.some(w => s.includes(w));
        if (hasAny(micro, ['taverna', 'locanda', 'pub', 'tavern', 'inn'])) {
            atmosphere = "You are a cheerful, slightly tipsy bard. You use tavern slang and crack jokes.";
        } else if (hasAny(micro, ['cripta', 'dungeon', 'grotta', 'tomba', 'crypt', 'cave', 'tomb'])) {
            atmosphere = "You speak in a whisper, tense and scared. Describe the unsettling sounds.";
        } else if (hasAny(micro, ['tempio', 'chiesa', 'santuario', 'temple', 'church', 'shrine', 'sanctuary'])) {
            atmosphere = "You use a solemn, respectful, almost religious tone.";
        } else if (hasAny(macro, ['corte', 'castello', 'palazzo', 'court', 'castle', 'palace'])) {
            atmosphere = "You use courtly, formal, very respectful language.";
        } else if (hasAny(micro, ['bosco', 'foresta', 'giungla', 'wood', 'forest', 'jungle'])) {
            atmosphere = "You are a naturalist bard. You speak of nature with wonder.";
        }
        atmosphere += `\nCURRENT LOCATION: ${loc.macro || "Unknown"} - ${loc.micro || "Unknown"}.`;
    }

    // Look for the NPCs named both in the current question and in the search queries
    // generated above (which already incorporate the conversational history) — a
    // follow-up question ("did they betray the party?") often does not name the NPC
    // by name, but the queries generated from the context do.
    const npcLookupText = [question, ...searchQueries].join(' ');
    const relevantNpcs = findNpcDossierByName(campaignId, npcLookupText);
    let socialContext = "";
    if (relevantNpcs.length > 0) {
        socialContext = "\n\n[[RELEVANT CHARACTER DOSSIERS]]\n";
        relevantNpcs.forEach((npc: any) => {
            socialContext += `- NAME: ${npc.name}\n  ROLE: ${npc.role || 'Unknown'}\n  STATUS: ${npc.status}\n  INFO: ${npc.description}\n`;
        });
        socialContext += "These dossiers are the CURRENT, up-to-date ground truth for each character's status — a character's situation can change between sessions (e.g. betrayal, death, relocation), and this dossier always reflects the latest known state. If a retrieved transcript excerpt below conflicts with this dossier (e.g. describes an earlier, since-changed status), TRUST THE DOSSIER. Use the transcripts for narrative detail and color, not to override these facts.\n";
    }

    // Output language = the campaign's language (prompt in canonical English).
    const systemPrompt = BARD_AGENTIC_PROMPT(atmosphere, socialContext, contextText)
        + aiOutputDirective(getCampaignLocale(campaignId));

    // runAgent has no separate history parameter (unlike generateText):
    // the conversational history has to be folded into the userPrompt.
    const historyText = history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
    const userPrompt = historyText
        ? `CONVERSATION HISTORY:\n${historyText}\n\nQUESTION: ${question}`
        : question;

    let answer: string;
    let grounded: boolean | null = null;
    let missing: string[] = [];
    let succeeded = true;
    try {
        const route = await getChatClient();
        // An extra bounded layer on top of the RAG already run above: a few targeted
        // tool calls at most, not an open agentic loop — predictable cost per exchange.
        const maxToolCalls = parseInt(process.env.ASKBARD_MAX_TOOL_CALLS || '2', 10);
        const result = await withRetry(() => runAgent({
            name: 'AskBard',
            client: route.client,
            model: route.model,
            provider: route.provider,
            creds: route.creds,
            maxTurns: 4,
            jsonMode: true,
            outputSchema: ASK_OUTPUT_SCHEMA,
            tools: createBardoTools(campaignId),
            requireToolUse: false,
            maxToolCalls,
            systemPrompt,
            userPrompt
        }));

        const answerCostEntry = buildAskCostEntry('ask_answer', route.provider, route.model, result.usage);
        if (answerCostEntry) costEntries.push(answerCostEntry);

        answer = result.output?.answer || t(getCampaignLocale(campaignId), 'rag.bardMute');
        // Absent means the model did not use the field, which is not the same as
        // a claim of groundedness — null says "it did not say", and the UI shows
        // nothing rather than a reassuring badge nobody earned.
        grounded = typeof result.output?.grounded === 'boolean' ? result.output.grounded : null;
        missing = Array.isArray(result.output?.missing)
            ? result.output.missing
                .filter((gap: unknown): gap is string => typeof gap === 'string' && gap.trim() !== '')
                .map((gap: string) => gap.trim())
                .slice(0, 5)
            : [];
    } catch (e) {
        console.error("[Chat] Errore:", e);
        answer = t(getCampaignLocale(campaignId), 'rag.bardFoggy');
        succeeded = false;
    }

    const totalCostUsd = costEntries.reduce((sum, e) => sum + e.costUSD, 0);
    const guildId = getCampaignById(campaignId)?.guild_id ?? null;
    const unavailableRate: UsdEurRate = {
        source: 'UNAVAILABLE',
        usdPerEur: null,
        rateDate: null,
        fetchedAt: null,
    };
    const exchangeRate = totalCostUsd > 0
        ? await getUsdEurRate()
        : unavailableRate;
    const totalEuroCost = buildEuroCostSnapshot(totalCostUsd, exchangeRate);
    if (costEntries.length > 0) {
        const entriesWithEuro = costEntries.map((entry) => {
            const snapshot = buildEuroCostSnapshot(entry.costUSD, exchangeRate);
            return {
                ...entry,
                costEUR: snapshot.costEur,
                usdPerEur: snapshot.usdPerEur,
                exchangeRateSource: snapshot.exchangeRateSource,
                exchangeRateDate: snapshot.exchangeRateDate,
                exchangeRateFetchedAt: snapshot.exchangeRateFetchedAt,
            };
        });
        aiUsageRepository.logSessionUsage('ASK', guildId, campaignId, entriesWithEuro);
        if (guildId && totalCostUsd > 0) {
            tenantRepository.addAiCost(guildId, totalCostUsd, totalEuroCost.costEur);
        }
    }

    // The log is ALWAYS present (even at $0/local provider) — the [AskBard][COST]
    // prefix is meant to be greppable in the container logs without having to
    // cross-reference the DB: `docker logs dnd-bot-prod | grep '\[AskBard\]\[COST\]'`.
    const breakdown = costEntries
        .map(e => `${e.phase}=$${e.costUSD.toFixed(6)}(${e.model},in=${e.inputTokens},out=${e.outputTokens})`)
        .join(' ');
    console.log(
        `[AskBard][COST] guild=${guildId ?? 'unknown'} campaign=${campaignId} ` +
        `total=$${totalCostUsd.toFixed(6)} ` +
        `eur=${totalEuroCost.costEur === null ? 'unavailable' : `€${totalEuroCost.costEur.toFixed(6)}`} ` +
        `${breakdown || '(nessuna chiamata a pagamento)'}`,
    );

    return { answer, grounded, missing, costUsd: totalCostUsd, costEur: totalEuroCost.costEur, succeeded };
}
