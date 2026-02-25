/**
 * Bard RAG Search - Search and retrieval functions
 */

import {
    getKnowledgeFragments,
    listNpcs,
    createEntityRef,
    filterEntityRefsByType,
    parseEntityRefs,
    migrateOldNpcIds,
    getCampaignLocationById,
    findNpcDossierByName
} from '../../db';
import {
    EMBEDDING_MODEL_OLLAMA,
    ollamaEmbedClient,
    getChatClient
} from '../config';
import { cosineSimilarity, withRetry } from '../helpers';
import { RAG_QUERY_GENERATION_PROMPT, BARD_ATMOSPHERE_PROMPT } from '../prompts';
import { monitor } from '../../monitor';

/**
 * Searches the knowledge base (RAG)
 */
export async function searchKnowledge(campaignId: number, query: string, limit: number = 5): Promise<string[]> {
    console.log(`[RAG] 🔍 Ricerca con ${EMBEDDING_MODEL_OLLAMA} (ollama)`);

    const startAI = Date.now();
    try {
        const resp = await ollamaEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OLLAMA,
            input: query
        });

        const queryVector = resp.data[0].embedding;
        monitor.logAIRequestWithCost(
            'embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA,
            0, 0, 0, Date.now() - startAI, false
        );

        let fragments = getKnowledgeFragments(campaignId, EMBEDDING_MODEL_OLLAMA);
        if (fragments.length === 0) return [];

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

        const scored = fragments.map((f, index) => {
            const vector = JSON.parse(f.embedding_json);
            let score = cosineSimilarity(queryVector, vector);

            if (currentMacro && f.macro_location === currentMacro) score += 0.05;
            if (currentMicro && f.micro_location === currentMicro) score += 0.10;

            if (query.length > 2 && f.content.toLowerCase().includes(query.toLowerCase())) {
                score += 0.5;
            }

            return { ...f, score, originalIndex: index };
        });

        scored.sort((a, b) => b.score - a.score);

        const topK = scored.slice(0, limit);
        const finalIndices = new Set<number>();

        topK.forEach(item => {
            finalIndices.add(item.originalIndex);
            if (item.originalIndex - 1 >= 0) {
                const prev = fragments[item.originalIndex - 1];
                if (prev.session_id === item.session_id) finalIndices.add(item.originalIndex - 1);
            }
            if (item.originalIndex + 1 < fragments.length) {
                const next = fragments[item.originalIndex + 1];
                if (next.session_id === item.session_id) finalIndices.add(item.originalIndex + 1);
            }
        });

        const finalFragments = Array.from(finalIndices)
            .sort((a, b) => a - b)
            .map(idx => fragments[idx].content);

        return finalFragments;

    } catch (e) {
        console.error("[RAG] ❌ Errore ricerca:", e);
        monitor.logAIRequestWithCost(
            'embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA,
            0, 0, 0, Date.now() - startAI, true
        );
        return [];
    }
}

/**
 * Generates search queries for the RAG agent
 */
export async function generateSearchQueries(campaignId: number, userQuestion: string, history: any[]): Promise<string[]> {
    const recentHistory = history.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');

    const prompt = RAG_QUERY_GENERATION_PROMPT(recentHistory, userQuestion);

    const { client, model, provider } = await getChatClient();
    const startAI = Date.now();
    try {
        const options: any = {
            model: model,
            messages: [{ role: "user", content: prompt }],
        };
        // response_format json_object solo per OpenAI (Gemini lo gestisce via prompt)
        if (provider === 'openai') options.response_format = { type: "json_object" };
        else if (provider === 'ollama') options.format = 'json';

        const response = await client.chat.completions.create(options);

        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        monitor.logAIRequestWithCost('chat', provider, model, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);

        const parsed = JSON.parse(response.choices[0].message.content || "{}");
        // Gestisce sia array diretto ["q1","q2"] sia oggetto {"queries":["q1","q2"]}
        if (Array.isArray(parsed)) return parsed;
        return Array.isArray(parsed.queries) ? parsed.queries : [];
    } catch (e) {
        monitor.logAIRequestWithCost('chat', provider, model, 0, 0, 0, Date.now() - startAI, true);
        return [userQuestion];
    }
}

/**
 * Ask Bard (Agentic RAG)
 */
export async function askBard(campaignId: number, question: string, history: { role: 'user' | 'assistant', content: string }[] = []): Promise<string> {

    const searchQueries = await generateSearchQueries(campaignId, question, history);
    console.log(`[AskBard] 🧠 Query generate:`, searchQueries);

    const promises = searchQueries.map(q => searchKnowledge(campaignId, q, 3));
    const results = await Promise.all(promises);
    const uniqueContext = Array.from(new Set(results.flat()));

    let contextText = uniqueContext.length > 0
        ? "MEMORIE RECUPERATE:\n" + uniqueContext.map(c => `...\\n${c}\\n...`).join("\\n")
        : "Nessuna memoria specifica trovata.";

    const MAX_CONTEXT_CHARS = 12000;
    if (contextText.length > MAX_CONTEXT_CHARS) {
        contextText = contextText.substring(0, MAX_CONTEXT_CHARS) + "\n... [TESTO TRONCATO]";
    }

    const loc = getCampaignLocationById(campaignId);
    let atmosphere = "Sei il Bardo della campagna. Rispondi in modo neutrale ma evocativo.";

    if (loc) {
        const micro = (loc.micro || "").toLowerCase();
        const macro = (loc.macro || "").toLowerCase();

        if (micro.includes('taverna') || micro.includes('locanda') || micro.includes('pub')) {
            atmosphere = "Sei un bardo allegro e un po' brillo. Usi slang da taverna, fai battute.";
        } else if (micro.includes('cripta') || micro.includes('dungeon') || micro.includes('grotta') || micro.includes('tomba')) {
            atmosphere = "Parli sottovoce, sei teso e spaventato. Descrivi i suoni inquietanti.";
        } else if (micro.includes('tempio') || micro.includes('chiesa') || micro.includes('santuario')) {
            atmosphere = "Usi un tono solenne, rispettoso e quasi religioso.";
        } else if (macro.includes('corte') || macro.includes('castello') || macro.includes('palazzo')) {
            atmosphere = "Usi un linguaggio aulico, formale e molto rispettoso.";
        } else if (micro.includes('bosco') || micro.includes('foresta') || micro.includes('giungla')) {
            atmosphere = "Sei un bardo naturalista. Parli con meraviglia della natura.";
        }
        atmosphere += `\nLUOGO ATTUALE: ${loc.macro || "Sconosciuto"} - ${loc.micro || "Sconosciuto"}.`;
    }

    const relevantNpcs = findNpcDossierByName(campaignId, question);
    let socialContext = "";
    if (relevantNpcs.length > 0) {
        socialContext = "\n\n[[DOSSIER PERSONAGGI RILEVANTI]]\n";
        relevantNpcs.forEach((npc: any) => {
            socialContext += `- NOME: ${npc.name}\n  RUOLO: ${npc.role || 'Sconosciuto'}\n  STATO: ${npc.status}\n  INFO: ${npc.description}\n`;
        });
        socialContext += "Usa queste informazioni, ma dai priorità ai fatti nelle trascrizioni.\n";
    }

    const systemPrompt = BARD_ATMOSPHERE_PROMPT(atmosphere, socialContext, contextText);

    const messages: any[] = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }];

    const { client, model, provider } = await getChatClient();
    const startAI = Date.now();
    try {
        const response: any = await withRetry(() => client.chat.completions.create({
            model: model,
            messages: messages as any
        }));

        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        monitor.logAIRequestWithCost('chat', provider, model, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);

        return response.choices[0].message.content || "Il Bardo è muto.";
    } catch (e) {
        console.error("[Chat] Errore:", e);
        monitor.logAIRequestWithCost('chat', provider, model, 0, 0, 0, Date.now() - startAI, true);
        return "La mia mente è annebbiata...";
    }
}
