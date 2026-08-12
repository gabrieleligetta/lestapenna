/**
 * Working out what a subject actually looks like, from the campaign's own material.
 *
 * This is the half of portrait generation that used to be missing. Before it, a
 * picture was drawn from the sheet plus four passages fetched by one fixed
 * query, paraphrased into a paragraph by a cheap model — a pipeline with no way
 * to say «the records do not describe her», and so one that answered anyway.
 *
 * The agent here is built like `questLifecycle.ts`, and for the same reason:
 * the facts are scattered across records that only a few targeted lookups can
 * connect. In particular the decisive one is never on the subject. Astrid Foe
 * wears the armour of the Dame di Ferro because of *who she serves*, and that
 * armour is described on the faction, where no query about her name will ever
 * reach it.
 *
 * The contract that makes the output usable is structural rather than
 * hortatory: a trait exists only as a `{ field, value, evidence, source }`
 * quadruple, and `normalizeAppearanceOutput` drops anything whose evidence is
 * missing or whose field is not in the vocabulary for that kind of subject.
 * Telling a model not to invent is a wish; giving it nowhere to put an
 * invention is a design.
 */

import type { AIProvider } from '../../config';
import { getAnalystClient } from '../config';
import { scopeForCampaign } from '../ai/scope';
import { subjectFacts, type SubjectFacts, type SubjectKind } from '../entityFacts';
import type {
    EntityAppearance,
    EntityMediaType,
    EntityPersonality,
    TraitConfidence,
    TraitEvidence,
    TraitSource,
} from '../../db/types';
import { APPEARANCE_OUTPUT_SCHEMA } from './outputSchemas';
import { AgentTool, runAgent } from './runtime';
import { createAppearanceTools, createBardoTools } from './tools';

export const APPEARANCE_MAX_TURNS = 6;
export const APPEARANCE_MAX_TOOL_CALLS = 8;

/**
 * The fields an artist can be told about, per kind of subject.
 *
 * A closed vocabulary on purpose. It keeps the prompt assembly downstream
 * deterministic (every field has one place in the sentence), and it is the
 * filter that turns "whatever the model felt like naming" into a record whose
 * shape the rest of the code can rely on.
 */
export const APPEARANCE_FIELDS: Record<SubjectKind, readonly string[]> = {
    person: [
        'age_band', 'build', 'height', 'skin',
        'hair.colour', 'hair.length', 'hair.style',
        'eyes', 'face_marks', 'garments',
        'armour.type', 'armour.material', 'armour.finish',
        'insignia', 'weapons', 'bearing',
    ],
    place: [
        'setting', 'architecture', 'materials', 'scale',
        'state', 'light', 'weather', 'notable_features',
    ],
    object: ['form', 'material', 'size', 'ornament', 'wear', 'glow'],
};

/**
 * The temperament fields, as paths.
 *
 * Prefixed like the appearance ones so that a single vocabulary can address
 * both: the sheet's editor and the ownership list do not care which half of the
 * dossier a field lives in.
 */
export const PERSONALITY_FIELDS = [
    'personality.temperament',
    'personality.manner',
    'personality.voice',
] as const;

/** Fields that hold several values rather than one. */
export const LIST_FIELDS = new Set(['face_marks', 'garments', 'weapons', 'notable_features']);

const CONFIDENCE_ORDER: Record<TraitConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export interface AppearanceAnalysisInput {
    campaignId: number;
    entityType: EntityMediaType;
    /** The public short id, as it appears in the URL. */
    entityId: string;
}

export interface NormalizedAppearance {
    appearance: EntityAppearance | null;
    personality: EntityPersonality | null;
    evidence: TraitEvidence[];
    /** The weakest trait's confidence: a dossier is only as good as its softest claim. */
    confidence: TraitConfidence | null;
    /** What was looked for and genuinely is not in the records. */
    notRecorded: string[];
}

export interface AppearanceAnalysisResult extends NormalizedAppearance {
    subject: SubjectFacts;
    tokens: { input: number; output: number; inputChars: number; outputChars: number; cached?: number };
    provider: AIProvider;
    model: string;
    debug: string;
}

/**
 * The subject does not exist in this campaign.
 *
 * Typed so the API can answer 404 rather than 500: asking about an entity that
 * is not there is a fact about the request, not a failure of the server.
 */
export class SubjectNotFoundError extends Error {
    readonly code = 'SUBJECT_NOT_FOUND';

    constructor(message: string) {
        super(message);
        this.name = 'SubjectNotFoundError';
    }
}

export const APPEARANCE_SYSTEM_PROMPT = [
    'You establish what a subject in a tabletop campaign looks like, strictly from that campaign\'s own records.',
    'You are a reporter of those records, not an illustrator and not a storyteller.',
    'Every claim you make must quote the material it came from. A claim you cannot quote is one you must not make.',
    'Leaving a field out is always correct when the records are silent about it. Inventing a plausible value is never correct.',
].join(' ');

export interface AppearanceAnalysisPreparation {
    subject: SubjectFacts;
    tools: AgentTool[];
    systemPrompt: string;
    userPrompt: string;
}

/**
 * Everything the run needs, built without a provider client.
 *
 * Pure on purpose, exactly like `prepareHistoricalQuestAudit`: the interesting
 * rules — which material is offered, which fields exist, what counts as
 * evidence — are then testable without mocking an SDK, and the estimate
 * endpoint can size the call without holding a credential.
 */
export function prepareAppearanceAnalysis(input: AppearanceAnalysisInput): AppearanceAnalysisPreparation {
    const subject = subjectFacts(input.campaignId, input.entityType, input.entityId);
    if (!subject) throw new SubjectNotFoundError('This entity does not exist in this campaign');

    const vocabulary = APPEARANCE_FIELDS[subject.kind];
    const wantsPersonality = subject.kind === 'person';

    const userPrompt = `Establish what ${subject.name} looks like, using ONLY this campaign's records.

## FIELD VOCABULARY — use these exact names in "field", and no others
${vocabulary.join(', ')}
${LIST_FIELDS.size > 0 ? `Repeatable fields (emit one entry per value): ${[...LIST_FIELDS].filter(field => vocabulary.includes(field)).join(', ') || 'none'}` : ''}

## BINDING RULES
1. Every trait needs "evidence": the words from the material that say it, quoted as closely as you can.
2. If the material does not say something, leave that field out and name it in "not_recorded". Never guess a value because it is likely, typical of the species, or common for the role.
3. Only describe what can be seen. Reputation, morality, plot and game statistics are not appearance.
4. A hand-written description on the sheet outranks anything inferred from play; the most recent and most specific wins over the general.
5. Membership of a faction lets you take that faction's livery, uniform or armour as this subject's, but only when the faction's own record describes it. Call get_faction_profile for each faction listed below.
6. Call search_transcripts for the subject's name: the exact words spoken at the table are the only place a physical detail is usually recorded, and they are not in the RAG.
7. "confidence" is HIGH only for an explicit statement about this subject, MEDIUM for something inherited (a faction's livery) or implied, LOW for a single vague mention.
8. ${wantsPersonality ? 'Fill "personality" the same way, with evidence, for temperament, manner and voice.' : 'Return an empty "personality" array: this subject is not a person.'}
9. Return only JSON matching the schema. No commentary.

## WHAT THE SHEET RECORDS
${subject.facts.length > 0 ? subject.facts.join('\n') : '(the sheet holds no description)'}

## FACTIONS THIS SUBJECT BELONGS TO
${subject.factions.length > 0 ? subject.factions.join(', ') : '(none recorded)'}

An empty result is a valid and useful answer. A campaign that never described this subject should produce no traits at all.`;

    return {
        subject,
        tools: [...createBardoTools(input.campaignId), ...createAppearanceTools(input.campaignId)],
        systemPrompt: APPEARANCE_SYSTEM_PROMPT,
        userPrompt,
    };
}

/**
 * Turns the model's flat trait list into a dossier, dropping what it may not claim.
 *
 * This is where the guarantee lives. Anything without evidence, with a field
 * outside the vocabulary, or with an empty value is discarded here — before it
 * reaches the database and long before it reaches a picture.
 */
export function normalizeAppearanceOutput(kind: SubjectKind, output: any): NormalizedAppearance {
    const vocabulary = new Set(APPEARANCE_FIELDS[kind]);
    const appearance: Record<string, any> = {};
    const personality: Record<string, string> = {};
    const evidence: TraitEvidence[] = [];
    let weakest: TraitConfidence | null = null;

    const rows: any[] = Array.isArray(output?.traits) ? output.traits : [];
    for (const row of rows) {
        const field = typeof row?.field === 'string' ? row.field.trim() : '';
        const value = typeof row?.value === 'string' ? row.value.trim() : '';
        const quote = typeof row?.evidence === 'string' ? row.evidence.trim() : '';
        if (!vocabulary.has(field) || value === '' || quote === '') continue;

        assign(appearance, field, value);
        evidence.push({
            trait: field,
            quote,
            source: asSource(row?.source),
            session_id: typeof row?.session === 'string' && row.session.trim() !== '' ? row.session.trim() : null,
        });
        weakest = weaker(weakest, asConfidence(row?.confidence));
    }

    const personalityRows: any[] = Array.isArray(output?.personality) ? output.personality : [];
    for (const row of personalityRows) {
        const field = typeof row?.field === 'string' ? row.field.trim() : '';
        const value = typeof row?.value === 'string' ? row.value.trim() : '';
        const quote = typeof row?.evidence === 'string' ? row.evidence.trim() : '';
        if (kind !== 'person') continue;
        if (!['temperament', 'manner', 'voice'].includes(field) || value === '' || quote === '') continue;

        personality[field] = value;
        evidence.push({
            trait: `personality.${field}`,
            quote,
            source: asSource(row?.source),
            session_id: typeof row?.session === 'string' && row.session.trim() !== '' ? row.session.trim() : null,
        });
        weakest = weaker(weakest, asConfidence(row?.confidence));
    }

    const notRecorded = (Array.isArray(output?.not_recorded) ? output.not_recorded : [])
        .filter((field: unknown): field is string => typeof field === 'string' && field.trim() !== '')
        .map((field: string) => field.trim())
        // Only report a gap in a field that could have been filled: a model
        // listing "backstory" as not recorded says nothing about the picture.
        .filter((field: string) => vocabulary.has(field));

    return {
        appearance: Object.keys(appearance).length > 0 ? (appearance as EntityAppearance) : null,
        personality: Object.keys(personality).length > 0 ? (personality as EntityPersonality) : null,
        evidence,
        confidence: weakest,
        notRecorded,
    };
}

/** Writes `hair.colour` into `{ hair: { colour } }`, appending where the field is a list. */
function assign(target: Record<string, any>, field: string, value: string): void {
    if (LIST_FIELDS.has(field)) {
        const existing: string[] = Array.isArray(target[field]) ? target[field] : [];
        if (!existing.includes(value)) existing.push(value);
        target[field] = existing;
        return;
    }

    const [head, tail] = field.split('.');
    if (!tail) {
        target[head] = value;
        return;
    }
    const nested = typeof target[head] === 'object' && target[head] !== null ? target[head] : {};
    nested[tail] = value;
    target[head] = nested;
}

function asSource(value: unknown): TraitSource {
    const allowed: TraitSource[] = ['sheet', 'history', 'faction', 'transcript', 'rag'];
    return allowed.includes(value as TraitSource) ? (value as TraitSource) : 'rag';
}

function asConfidence(value: unknown): TraitConfidence {
    return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' ? value : 'LOW';
}

function weaker(current: TraitConfidence | null, candidate: TraitConfidence): TraitConfidence {
    if (!current) return candidate;
    return CONFIDENCE_ORDER[candidate] < CONFIDENCE_ORDER[current] ? candidate : current;
}

/**
 * Runs the analysis on the **analyst** phase.
 *
 * Not `metadata`, which writes the mechanical paragraphs: this pass has to read
 * several records, follow a subject into their faction and weigh contradictory
 * mentions, and giving that to the cheapest configured model is how the
 * previous version produced confident fiction.
 */
export async function runEntityAppearanceAgent(
    input: AppearanceAnalysisInput,
): Promise<AppearanceAnalysisResult> {
    const prepared = prepareAppearanceAnalysis(input);
    const { client, model, provider, creds } = await getAnalystClient(scopeForCampaign(input.campaignId));

    const result = await runAgent({
        name: 'Analista:appearance',
        client,
        model,
        provider,
        creds,
        maxTurns: APPEARANCE_MAX_TURNS,
        jsonMode: true,
        outputSchema: APPEARANCE_OUTPUT_SCHEMA,
        reasoningEffort: 'medium',
        numCtx: 32768,
        tools: prepared.tools,
        requireToolUse: true,
        requiredTools: ['search_transcripts'],
        maxToolCalls: APPEARANCE_MAX_TOOL_CALLS,
        systemPrompt: prepared.systemPrompt,
        userPrompt: prepared.userPrompt,
    });

    return {
        ...normalizeAppearanceOutput(prepared.subject.kind, result.output),
        subject: prepared.subject,
        tokens: result.usage,
        provider,
        model,
        debug: JSON.stringify(result.transcript, null, 2),
    };
}

/**
 * The dossier as a person reads it.
 *
 * Rendered here rather than asked of the model: a second generative step to
 * turn facts into a sentence is a second chance to add one that was not there.
 */
export function renderAppearanceText(appearance: EntityAppearance | null): string | null {
    if (!appearance) return null;
    const parts: string[] = [];

    for (const [key, value] of Object.entries(appearance as Record<string, any>)) {
        if (value === null || value === undefined) continue;
        const label = key.replace(/_/g, ' ');
        if (Array.isArray(value)) {
            if (value.length > 0) parts.push(`${label}: ${value.join(', ')}`);
        } else if (typeof value === 'object') {
            const inner = Object.entries(value)
                .filter(([, nested]) => typeof nested === 'string' && nested.trim() !== '')
                .map(([nestedKey, nested]) => `${nestedKey} ${nested}`)
                .join(', ');
            if (inner) parts.push(`${label}: ${inner}`);
        } else if (String(value).trim() !== '') {
            parts.push(`${label}: ${String(value).trim()}`);
        }
    }

    return parts.length > 0 ? parts.join('; ') : null;
}
