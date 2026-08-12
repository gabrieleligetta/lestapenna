/**
 * Moral Reassessment - narrow, self-gated second pass that re-weighs moral_impact/
 * ethical_impact on high-magnitude NPC events using the NPC's dossier description and
 * recent history as motive context, instead of the Analyst's rigid category→score table.
 *
 * Only invoked for events with |moral_impact| >= 3 or |ethical_impact| >= 3 (see
 * src/bard/validation.ts validateBatch), so it stays rare and cheap: no castContext/
 * memoryContext/atlasContext is ever sent here, only the flagged event + one NPC's
 * description + short history.
 */

import { getAnalystClient } from './config';
import { generateJson } from './llm/generate';

export interface MoralReassessmentCandidate {
    name: string;
    event: string;
    type: string;
    moral_impact: number;
    ethical_impact: number;
    dossierDescription: string;
    recentHistory: string;
}

export interface MoralReassessmentResult {
    name: string;
    moral_impact: number;
    ethical_impact: number;
    motive: string;
}

export const MORAL_REASSESSMENT_PROMPT = (candidates: MoralReassessmentCandidate[]) => `You are the Keeper of Motives of a D&D campaign. Your ONLY task is to recalibrate
moral_impact and ethical_impact of already-extracted NPC events, in light of the NPC's motive and
prior history. Do NOT rewrite the event text. Do NOT change the event type.

RULES:
1. ethical_impact (Lawful<->Chaotic) measures ONLY the objective action (did they break a pact/code/trust?).
   As a rule it must NOT be softened by the motive: keep the provided value unless the CONTEXT
   reveals the action is not really a breach of trust (e.g. the NPC had never made a pact).
2. moral_impact (Good<->Evil) measures ONLY the intent. Reduce the severity (move towards 0) if the
   CONTEXT (NPC description, recent history) reveals the NPC acted out of:
   - survival, fear, despair, grief or personal trauma -> range -1/-4 even if the action is serious
   - self-interest without cruelty -> range -2/-5
   Keep or INCREASE the severity if the CONTEXT reveals deliberate cruelty, enjoyment in doing
   harm, or a pattern of repeated evil actions.
3. If you find no evidence of a mitigating motive in the CONTEXT, do NOT change the provided value.
4. Do not invent motives unsupported by the CONTEXT.

EVENTS TO RECALIBRATE:
${candidates.map((c, i) => `${i + 1}. NPC: ${c.name}
   Event: [${c.type}] ${c.event}
   Current values: moral_impact=${c.moral_impact}, ethical_impact=${c.ethical_impact}
   NPC dossier description: ${c.dossierDescription || 'N/A'}
   Recent history: ${c.recentHistory || 'N/A'}`).join('\n\n')}

Answer ONLY with JSON:
{"reassessments":[{"name":"NPCName","moral_impact":number,"ethical_impact":number,"motive":"short explanation of the identified motive or 'no mitigating motive found'"}]}`;

/**
 * Re-weighs moral_impact/ethical_impact for high-magnitude NPC events using dossier +
 * history context. Returns the input values unchanged for any candidate the LLM call
 * fails on or doesn't return a result for (fail-safe: never blocks ingestion).
 */
export async function reassessNpcMoralWeights(
    candidates: MoralReassessmentCandidate[]
): Promise<MoralReassessmentResult[]> {
    const fallback = candidates.map(c => ({
        name: c.name,
        moral_impact: c.moral_impact,
        ethical_impact: c.ethical_impact,
        motive: 'reassessment non eseguita'
    }));

    if (candidates.length === 0) return fallback;

    if (process.env.DISABLE_MORAL_REASSESSMENT === 'true') {
        console.log('[MoralReassessment] ⏸️ Disabilitato via DISABLE_MORAL_REASSESSMENT.');
        return fallback;
    }

    const prompt = MORAL_REASSESSMENT_PROMPT(candidates);

    try {
        const ai = await generateJson({
            route: await getAnalystClient(),
            label: 'moral_reassessment',
            system: 'You are the Keeper of Motives. You recalibrate moral/ethical scores of already-extracted NPC events. Answer only with JSON.',
            prompt,
            maxTokensNative: 1500
        });
        const parsed: any = ai.parsed;

        const reassessments: MoralReassessmentResult[] = Array.isArray(parsed?.reassessments) ? parsed.reassessments : [];
        const byName = new Map(reassessments.map((r: any) => [String(r.name || '').toLowerCase(), r]));

        return candidates.map(c => {
            const revised = byName.get(c.name.toLowerCase());
            if (!revised) {
                console.warn(`[MoralReassessment] ⚠️ Nessuna rivalutazione ricevuta per "${c.name}", mantengo i valori originali.`);
                return { name: c.name, moral_impact: c.moral_impact, ethical_impact: c.ethical_impact, motive: 'nessuna rivalutazione ricevuta' };
            }
            const moral = Number.isFinite(Number(revised.moral_impact)) ? Number(revised.moral_impact) : c.moral_impact;
            const ethical = Number.isFinite(Number(revised.ethical_impact)) ? Number(revised.ethical_impact) : c.ethical_impact;
            if (moral !== c.moral_impact || ethical !== c.ethical_impact) {
                console.log(`[MoralReassessment] 🎭 "${c.name}": moral ${c.moral_impact}→${moral}, ethical ${c.ethical_impact}→${ethical} (${revised.motive || 'n/d'})`);
            }
            return { name: c.name, moral_impact: moral, ethical_impact: ethical, motive: revised.motive || '' };
        });
    } catch (e: any) {
        console.error('[MoralReassessment] ❌ Errore durante la rivalutazione:', e);
        return fallback;
    }
}
