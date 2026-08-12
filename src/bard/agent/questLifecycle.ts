import {
    normalizeQuestStatus,
    normalizeQuestType,
    QuestStatus,
    questRepository
} from '../../db';
import type { AIProvider } from '../../config';
import { aiOutputDirective, getCampaignLocale } from '../../i18n';
import { getAnalystClient } from '../config';
import {
    AnalystOutput,
    QuestLifecycleDecision,
    QuestLifecycleOutput
} from '../types';
import { AgentTool, runAgent } from './runtime';
import { SessionRagIndex } from './sessionRag';
import { createAgentTools } from './tools';

const QUEST_LIFECYCLE_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        decisions: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    title: { type: 'string' as const },
                    current_status: {
                        type: 'string' as const,
                        enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED']
                    },
                    proposed_status: {
                        type: 'string' as const,
                        enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED']
                    },
                    description: { type: 'string' as const },
                    type: { type: 'string' as const, enum: ['MAJOR', 'MINOR'] },
                    evidence: { type: 'string' as const },
                    confidence: { type: 'string' as const, enum: ['HIGH', 'MEDIUM', 'LOW'] },
                    action: {
                        type: 'string' as const,
                        enum: ['NO_CHANGE', 'STATUS_CHANGE', 'CREATE']
                    }
                },
                required: [
                    'id', 'title', 'current_status', 'proposed_status',
                    'description', 'type', 'evidence', 'confidence', 'action'
                ],
                additionalProperties: false
            }
        }
    },
    required: ['decisions'],
    additionalProperties: false
};

export interface QuestLifecycleRunResult {
    data: QuestLifecycleOutput;
    debug: string;
    tokens: {
        input: number;
        output: number;
        inputChars: number;
        outputChars: number;
        cached?: number;
    };
    provider?: AIProvider;
    model?: string;
}

const ZERO_TOKENS = { input: 0, output: 0, inputChars: 0, outputChars: 0 };
export const HISTORICAL_QUEST_AUDIT_MAX_TURNS = 5;
export const HISTORICAL_QUEST_AUDIT_MAX_TOOL_CALLS = 3;
export const HISTORICAL_QUEST_AUDIT_MAX_TOOL_RESULT_CHARS = 2500;
export const HISTORICAL_QUEST_AUDIT_SYSTEM_PROMPT =
    'You conservatively audit D&D quest history. Use canonical enums and direct chronological evidence. Never mutate data or invent.';

function compact(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    const half = Math.floor(maxChars / 2);
    return `${value.slice(0, half)}\n\n[... transcript compacted ...]\n\n${value.slice(-half)}`;
}

function normalizeLifecycleOutput(campaignId: number, raw: any): QuestLifecycleOutput {
    const openQuests = questRepository.getOpenQuests(campaignId, 1000, 0);
    const openById = new Map(
        openQuests
            .filter(quest => quest.short_id)
            .map(quest => [String(quest.short_id).toLowerCase(), quest])
    );
    const allTitles = new Set(
        questRepository.listAllQuests(campaignId).map(quest => quest.title.trim().toLowerCase())
    );
    const seenExisting = new Set<string>();
    const decisions: QuestLifecycleDecision[] = [];

    for (const candidate of Array.isArray(raw?.decisions) ? raw.decisions : []) {
        const action = candidate?.action;
        const proposedStatus = normalizeQuestStatus(candidate?.proposed_status);
        const type = normalizeQuestType(candidate?.type);
        const confidence = candidate?.confidence;
        const evidence = String(candidate?.evidence || '').trim();
        const description = String(candidate?.description || '').trim();
        const title = String(candidate?.title || '').trim();
        if (
            !['NO_CHANGE', 'STATUS_CHANGE', 'CREATE'].includes(action) ||
            !proposedStatus ||
            !type ||
            !['HIGH', 'MEDIUM', 'LOW'].includes(confidence) ||
            !title
        ) continue;

        if (action === 'CREATE') {
            if (
                proposedStatus === QuestStatus.COMPLETED ||
                proposedStatus === QuestStatus.FAILED ||
                allTitles.has(title.toLowerCase())
            ) continue;
            allTitles.add(title.toLowerCase());
            decisions.push({
                title,
                proposed_status: proposedStatus,
                description,
                type,
                evidence,
                confidence,
                action
            });
            continue;
        }

        const id = String(candidate?.id || '').trim().toLowerCase();
        const existing = openById.get(id);
        if (!existing || seenExisting.has(id)) continue;
        seenExisting.add(id);
        const currentStatus = normalizeQuestStatus(existing.status) || QuestStatus.OPEN;
        const finalAction = action === 'STATUS_CHANGE' && proposedStatus !== currentStatus
            ? 'STATUS_CHANGE'
            : 'NO_CHANGE';
        decisions.push({
            id: existing.short_id,
            title: existing.title,
            current_status: currentStatus,
            proposed_status: finalAction === 'NO_CHANGE' ? currentStatus : proposedStatus,
            description,
            type: normalizeQuestType(existing.type) || type,
            evidence,
            confidence,
            action: finalAction
        });
    }

    // Deterministic coverage: a quest omitted by the model counts as NO_CHANGE.
    for (const quest of openQuests) {
        const id = String(quest.short_id || '').toLowerCase();
        if (!id || seenExisting.has(id)) continue;
        const status = normalizeQuestStatus(quest.status) || QuestStatus.OPEN;
        decisions.push({
            id: quest.short_id,
            title: quest.title,
            current_status: status,
            proposed_status: status,
            description: '',
            type: normalizeQuestType(quest.type) || 'MAJOR',
            evidence: '',
            confidence: 'LOW',
            action: 'NO_CHANGE'
        });
    }
    return { decisions };
}

export async function runQuestLifecycleAgent(input: {
    campaignId: number;
    sessionId: string;
    narrativeText: string;
    analystData: AnalystOutput;
    manifesto?: string;
}): Promise<QuestLifecycleRunResult> {
    const openQuests = questRepository.getOpenQuests(input.campaignId, 30, 0);
    const analystCandidates = Array.isArray(input.analystData.quests)
        ? input.analystData.quests
        : [];
    // Zero-cost fast path: no state to evaluate and no candidate to open.
    if (openQuests.length === 0 && analystCandidates.length === 0) {
        return {
            data: { decisions: [] },
            debug: 'Skipped: no open quests or quest candidates.',
            tokens: ZERO_TOKENS
        };
    }

    const sessionRag = new SessionRagIndex(input.narrativeText);
    const tools = createAgentTools(input.campaignId, sessionRag, input.manifesto || '');
    const { client, model, provider, creds } = await getAnalystClient();
    const prompt = `You are the Quest Lifecycle specialist inside a D&D Analyst pipeline.

## CANONICAL ENUM CONTRACT — COPY THESE VALUES EXACTLY
- status: OPEN | IN_PROGRESS | COMPLETED | FAILED
- type: MAJOR | MINOR
- action: NO_CHANGE | STATUS_CHANGE | CREATE
- confidence: HIGH | MEDIUM | LOW

## DEFINITIONS
- OPEN: a known objective that has not been actively pursued yet.
- IN_PROGRESS: an accepted or implicit narrative objective that the party is actively pursuing.
- COMPLETED: the objective described by that exact quest was achieved successfully.
- FAILED: the objective became impossible or was explicitly failed.

## BINDING RULES
1. Call get_open_quests before answering and evaluate EVERY returned quest.
2. Existing quests MUST use their exact five-character id and canonical title.
3. Search the current transcript for concrete evidence before STATUS_CHANGE.
4. Completing a milestone does not complete a broader multi-part objective.
5. Never reopen a completed/failed quest. Never create a duplicate or a renamed copy.
6. CREATE may include an implicit narrative arc when the party clearly commits to pursuing it.
7. HIGH means direct, unambiguous evidence. MEDIUM/LOW decisions are review suggestions only.
8. For unchanged quests emit NO_CHANGE with proposed_status equal to current_status.
9. For CREATE use id="" and current_status="OPEN"; proposed_status may be OPEN or IN_PROGRESS only.
10. Return only JSON matching the schema.
11. Tool budget is strict: one get_open_quests call plus at most two targeted transcript calls.

## OPEN QUEST SNAPSHOT
${JSON.stringify(openQuests, null, 2)}

## GENERAL ANALYST QUEST CANDIDATES
${JSON.stringify(analystCandidates, null, 2)}

## CURRENT SESSION TRANSCRIPT
${compact(input.narrativeText, 40000)}

${aiOutputDirective(getCampaignLocale(input.campaignId))}`;

    const result = await runAgent({
        name: 'Analista:quest-lifecycle',
        client,
        model,
        provider,
        creds,
        maxTurns: 5,
        jsonMode: true,
        outputSchema: QUEST_LIFECYCLE_OUTPUT_SCHEMA,
        reasoningEffort: 'medium',
        numCtx: 32768,
        tools,
        requireToolUse: true,
        requiredTools: ['get_open_quests'],
        maxToolCalls: 3,
        systemPrompt: 'You are a conservative D&D quest lifecycle analyst. Use tools, canonical enums and direct transcript evidence. Never invent.',
        userPrompt: prompt
    });

    return {
        data: normalizeLifecycleOutput(input.campaignId, result.output),
        debug: JSON.stringify(result.transcript, null, 2),
        tokens: result.usage,
        provider,
        model
    };
}

/**
 * Administrative audit, separate from the session flow: a single call evaluates
 * every open quest against the already summarized chronicle. The caller persists
 * only reviewable proposals and never applies states automatically.
 */
export interface HistoricalQuestAuditPreparation {
    timelineText: string;
    tools: AgentTool[];
    systemPrompt: string;
    userPrompt: string;
    openQuestCount: number;
    toolSchemaChars: number;
}

export function prepareHistoricalQuestAudit(input: {
    campaignId: number;
    timelineText: string;
}): HistoricalQuestAuditPreparation {
    const timelineText = compact(input.timelineText, 120000);
    const timelineRag = new SessionRagIndex(timelineText);
    const tools = createAgentTools(input.campaignId, timelineRag);
    const openQuests = questRepository.getOpenQuests(input.campaignId, 30, 0);
    const userPrompt = `You are auditing the historical lifecycle of D&D quests.

## CANONICAL ENUM CONTRACT — COPY THESE VALUES EXACTLY
- status: OPEN | IN_PROGRESS | COMPLETED | FAILED
- type: MAJOR | MINOR
- action: NO_CHANGE | STATUS_CHANGE
- confidence: HIGH | MEDIUM | LOW

## AUDIT RULES
1. Call get_open_quests exactly once and evaluate EVERY returned quest.
2. Existing quests MUST use their exact five-character id and canonical title.
3. Use only events at or after each quest's created_at timestamp.
4. COMPLETED requires direct evidence that the exact objective was achieved.
5. FAILED requires direct evidence that the exact objective became impossible or explicitly failed.
6. A mention, meeting, partial milestone or broader plot progress is not completion.
7. Never CREATE, rename, reopen, or modify a quest. This audit only proposes terminal STATUS_CHANGE decisions.
8. Include the session number/id and concise factual evidence when proposing a change.
9. HIGH means unambiguous historical evidence. MEDIUM/LOW remain review-only.
10. For unchanged quests emit NO_CHANGE with proposed_status equal to current_status.
11. Return only JSON matching the schema.
12. Tool budget is strict: one get_open_quests call plus at most two targeted timeline calls.

## OPEN QUEST SNAPSHOT
${JSON.stringify(openQuests, null, 2)}

## CHRONOLOGICAL SESSION TIMELINE
${timelineText}

${aiOutputDirective(getCampaignLocale(input.campaignId))}`;
    const toolSchemaChars = JSON.stringify(
        tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        })),
    ).length;
    return {
        timelineText,
        tools,
        systemPrompt: HISTORICAL_QUEST_AUDIT_SYSTEM_PROMPT,
        userPrompt,
        openQuestCount: openQuests.length,
        toolSchemaChars,
    };
}

export async function runHistoricalQuestAuditAgent(input: {
    campaignId: number;
    timelineText: string;
}): Promise<QuestLifecycleRunResult> {
    const prepared = prepareHistoricalQuestAudit(input);
    const { client, model, provider, creds } = await getAnalystClient();

    const result = await runAgent({
        name: 'Analista:quest-history-audit',
        client,
        model,
        provider,
        creds,
        maxTurns: HISTORICAL_QUEST_AUDIT_MAX_TURNS,
        jsonMode: true,
        outputSchema: QUEST_LIFECYCLE_OUTPUT_SCHEMA,
        reasoningEffort: 'medium',
        numCtx: 32768,
        tools: prepared.tools,
        requireToolUse: true,
        requiredTools: ['get_open_quests'],
        maxToolCalls: HISTORICAL_QUEST_AUDIT_MAX_TOOL_CALLS,
        systemPrompt: prepared.systemPrompt,
        userPrompt: prepared.userPrompt
    });

    const normalized = normalizeLifecycleOutput(input.campaignId, result.output);
    return {
        data: {
            decisions: normalized.decisions.filter(decision => decision.action !== 'CREATE')
        },
        debug: JSON.stringify(result.transcript, null, 2),
        tokens: result.usage,
        provider,
        model
    };
}
