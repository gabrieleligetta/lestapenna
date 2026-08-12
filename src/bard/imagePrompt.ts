/**
 * Turning an entity into something an image model can draw.
 *
 * The prompt is **assembled**, not written. When the subject has an appearance
 * dossier (`entity_profile`), each recorded trait goes into a fixed slot of a
 * fixed sentence and nothing else is added. There is no generative step between
 * the record and the picture, which is the whole point: the previous version
 * asked a cheap model for one flowing paragraph, and a paragraph writer drops
 * «white hair» for rhythm and fills a silent field with something plausible.
 * Assembly cannot do either — and it makes the same dossier produce the same
 * prompt every time, so a regeneration is a regeneration and not a re-roll.
 *
 * The three modes are three answers to one question — *where do the words come
 * from* — and they share everything after it:
 *
 *  - **auto** — the campaign's own records. The dossier when there is one; the
 *    old sheet-and-RAG brief, with its one text call, only as a fallback for a
 *    subject nobody has analysed yet.
 *  - **prompt** — the person's words, and only those. No text call at all:
 *    someone who wrote what they want has already done the work, and paying a
 *    model to reword them would be charging for the privilege.
 *  - **mixed** — both, with the person's words binding. When the record says
 *    grey-haired and the request says young, the request wins; the material is
 *    there to fill silence, not to argue.
 *
 * The instruction language is English, like every other prompt in the repo. It
 * takes no `aiOutputDirective`: the output is a picture, and a picture has no
 * language.
 */

import { getMetadataClient } from './config';
import { generateText } from './llm/generate';
import type { ImageShape } from './llm/image';
import { searchKnowledge } from './rag/search';
import { scopeForCampaign } from './ai/scope';
import { subjectFacts, SUBJECT_KIND, type SubjectKind } from './entityFacts';
import { shotLines, type ImageShot } from './imageShot';
import { campaignRepository } from '../db/repositories/CampaignRepository';
import {
    entityProfileRepository,
    parseAppearance,
    parsePersonality,
} from '../db/repositories/EntityProfileRepository';
import type {
    EntityAppearance,
    EntityMediaType,
    ImageGenerationMode,
    ObjectAppearance,
    PersonAppearance,
    PlaceAppearance,
} from '../db/types';

/** How many retrieved passages the fallback brief gets. A description, not a chapter. */
const RAG_PASSAGES = 4;

/** A retrieved passage longer than this is a scene, not a description of anything. */
const MAX_PASSAGE_CHARS = 600;

/** The user's own text: long enough for a real description, short of an essay. */
export const MAX_USER_PROMPT_CHARS = 1000;

/**
 * The framing each kind of card displays its picture in.
 *
 * From `docs/ENTITY-MEDIA-AND-INVENTORY-DESIGN.md`, which decided the slots
 * before any of this existed: generating a square for a slot rendered 4:5 would
 * crop a face in half.
 */
const SHAPE_BY_ENTITY: Record<EntityMediaType, ImageShape> = {
    npc: 'portrait',
    character: 'portrait',
    location: 'landscape',
    artifact: 'square',
};

export function shapeFor(entityType: EntityMediaType): ImageShape {
    return SHAPE_BY_ENTITY[entityType];
}

/**
 * The default house style, used when a campaign has not set its own.
 *
 * Not decoration: without it one table's gallery becomes a photograph next to
 * an anime cel next to an oil painting, and the sheets stop looking like they
 * belong to the same world.
 */
const DEFAULT_STYLE: Record<SubjectKind, string> = {
    person: 'A character portrait for a fantasy tabletop campaign: painterly digital illustration.',
    place: 'A view of a place in a fantasy tabletop campaign: painterly digital illustration, no people in the foreground.',
    object: 'A single object from a fantasy tabletop campaign, presented like a museum plate: painterly digital illustration, centred.',
};

/**
 * The instruction against lettering.
 *
 * Image models like to write, and a portrait captioned in invented runes is
 * worse than one with no caption at all.
 */
const NO_TEXT_RULE = 'Do not render any text, letters, numbers, watermarks or signatures anywhere in the image.';

/**
 * Said out loud to the model, because a dossier is deliberately incomplete.
 *
 * Without it a model treats a short brief as an invitation to furnish the rest,
 * and the missing half comes back as invention — which is exactly the failure
 * the dossier exists to end. Better a plain background than a fabricated one.
 */
const NO_INVENTION_RULE = 'Depict only what is described above. Where a detail is not given, keep it plain and unremarkable rather than inventing something distinctive.';

export interface PortraitPromptRequest {
    campaignId: number;
    entityType: EntityMediaType;
    /**
     * The entity's **public** identifier, as it appears in the URL: the short id
     * for npc/location/artifact, the Discord user id for a character.
     *
     * Deliberately not `ResolvedMediaEntity.entityKey`, which is the internal row
     * id for three of the four types. Passing that here looked right and found
     * nothing — every lookup below is by short id — so the whole feature threw on
     * its first real request while the tests, which stubbed these very
     * repositories, stayed green.
     */
    entityId: string;
    mode: ImageGenerationMode;
    /** The person's own words. Required for `prompt` and `mixed`. */
    userPrompt?: string | null;
    /**
     * How the picture should be taken: how close, from where, in what light.
     *
     * Separate from the description because it is a different question. The
     * dossier says what the subject looks like; this says whether we are seeing
     * their face or their boots — and without it every portrait came out the
     * same bust, however much the campaign had established about the rest.
     */
    shot?: ImageShot | null;
}

/**
 * There is nothing in this campaign to draw.
 *
 * Typed so the API can answer 404 instead of 500: an entity that does not exist,
 * or one with nothing written about it yet, is a fact about the request — not a
 * failure of the server.
 */
export class NothingToDrawError extends Error {
    readonly code = 'NOTHING_TO_DRAW';

    constructor(message: string) {
        super(message);
        this.name = 'NothingToDrawError';
    }
}

export interface PortraitPrompt {
    /** What will be sent to the image model. */
    prompt: string;
    /** Which ingredients actually contributed — for the UI, and for the record. */
    sources: Array<'dossier' | 'sheet' | 'rag' | 'user'>;
    shape: ImageShape;
    /** True when a text model was called to write the brief; the estimate needs it. */
    usedTextCall: boolean;
    /** Tokens that text call consumed, so the real cost can be logged. */
    textUsage: { input: number; output: number; cached: number } | null;
}

/**
 * Builds the prompt for one portrait.
 *
 * Where a text call survives — a subject with no dossier — it runs on the
 * **metadata** phase: the cheapest one every table has configured, and turning
 * notes into a paragraph is the mechanical work that phase exists for.
 */
export async function buildPortraitPrompt(request: PortraitPromptRequest): Promise<PortraitPrompt> {
    const { campaignId, entityType, entityId, mode } = request;
    const shape = shapeFor(entityType);
    const kind = SUBJECT_KIND[entityType];
    const style = artDirection(campaignId, kind);
    const userPrompt = (request.userPrompt ?? '').trim().slice(0, MAX_USER_PROMPT_CHARS);

    const shot = shotLines(kind, request.shot).join(' ');

    if (mode === 'prompt') {
        if (!userPrompt) throw new NothingToDrawError('This mode needs a description to work from');
        return {
            prompt: [style, userPrompt, shot, NO_TEXT_RULE].join('\n\n'),
            sources: ['user'],
            shape,
            usedTextCall: false,
            textUsage: null,
        };
    }

    const dossier = describeFromDossier(campaignId, entityType, entityId);
    if (dossier) {
        // The assembled path: no model between the record and the picture.
        const sections = [style, dossier];
        if (mode === 'mixed' && userPrompt) {
            sections.push(`The person asking adds this, and it overrides anything above that contradicts it: ${userPrompt}`);
        }
        sections.push(shot, NO_INVENTION_RULE, NO_TEXT_RULE);

        return {
            prompt: sections.join('\n\n'),
            sources: mode === 'mixed' && userPrompt ? ['dossier', 'user'] : ['dossier'],
            shape,
            usedTextCall: false,
            textUsage: null,
        };
    }

    return buildBriefedPrompt({ campaignId, entityType, entityId, mode, userPrompt, style, shape, shot });
}

/**
 * The subject's recorded traits, as one paragraph of fixed slots.
 *
 * Returns null when the campaign has no dossier for it, or has one with nothing
 * in it — a subject nobody ever described stays undescribed here too.
 */
export function describeFromDossier(
    campaignId: number,
    entityType: EntityMediaType,
    entityId: string,
): string | null {
    const entry = entityProfileRepository.getForEntity(campaignId, entityType, entityId);
    const appearance = parseAppearance(entry);
    if (!appearance) return null;

    const kind = SUBJECT_KIND[entityType];
    const lines = kind === 'person'
        ? personLines(appearance as PersonAppearance)
        : kind === 'place'
            ? placeLines(appearance as PlaceAppearance)
            : objectLines(appearance as ObjectAppearance);

    if (lines.length === 0) return null;

    // The temperament, only where it can be seen: a portrait shows a bearing,
    // not a biography, so only `manner` reaches the picture.
    const personality = kind === 'person' ? parsePersonality(entry).fields : null;
    if (personality?.manner) lines.push(`Expression and manner: ${personality.manner}.`);

    return lines.join(' ');
}

function personLines(appearance: PersonAppearance): string[] {
    const lines: string[] = [];

    const build = list([appearance.age_band, appearance.build, appearance.height, appearance.skin && `${appearance.skin} skin`]);
    if (build) lines.push(`Subject: ${build}.`);

    const hair = list([appearance.hair?.colour, appearance.hair?.length, appearance.hair?.style]);
    if (hair) lines.push(`Hair: ${hair}.`);
    if (appearance.eyes) lines.push(`Eyes: ${appearance.eyes}.`);
    if (appearance.face_marks?.length) lines.push(`Distinguishing marks: ${appearance.face_marks.join(', ')}.`);

    const armour = list([appearance.armour?.type, appearance.armour?.material, appearance.armour?.finish]);
    const worn = [...(appearance.garments ?? []), ...(armour ? [armour] : [])];
    if (worn.length > 0) lines.push(`Wearing: ${worn.join('; ')}.`);
    if (appearance.insignia) lines.push(`Insignia: ${appearance.insignia}.`);
    if (appearance.weapons?.length) lines.push(`Carrying: ${appearance.weapons.join(', ')}.`);
    if (appearance.bearing) lines.push(`Bearing: ${appearance.bearing}.`);

    return lines;
}

function placeLines(appearance: PlaceAppearance): string[] {
    const lines: string[] = [];
    const setting = list([appearance.setting, appearance.scale]);
    if (setting) lines.push(`Place: ${setting}.`);
    const built = list([appearance.architecture, appearance.materials, appearance.state]);
    if (built) lines.push(`Built of: ${built}.`);
    const air = list([appearance.light, appearance.weather]);
    if (air) lines.push(`Light and weather: ${air}.`);
    if (appearance.notable_features?.length) lines.push(`Notable: ${appearance.notable_features.join(', ')}.`);
    return lines;
}

function objectLines(appearance: ObjectAppearance): string[] {
    const lines: string[] = [];
    const body = list([appearance.form, appearance.size, appearance.material]);
    if (body) lines.push(`Object: ${body}.`);
    if (appearance.ornament) lines.push(`Ornament: ${appearance.ornament}.`);
    if (appearance.wear) lines.push(`Condition: ${appearance.wear}.`);
    if (appearance.glow) lines.push(`Magical effect: ${appearance.glow}.`);
    return lines;
}

function list(values: Array<string | null | undefined | false>): string | null {
    const kept = values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    return kept.length > 0 ? kept.join(', ') : null;
}

/** The campaign's own house style, or the built-in one. */
function artDirection(campaignId: number, kind: SubjectKind): string {
    const own = campaignRepository.getCampaignById(campaignId)?.art_direction;
    return own?.trim() ? own.trim() : DEFAULT_STYLE[kind];
}

const BRIEF_SYSTEM = [
    'You write briefs for an image generation model, for a fantasy tabletop campaign.',
    'You are given what a campaign records about one subject, and possibly a request from the player.',
    'Return ONE paragraph, at most 120 words, describing only what can be seen:',
    'physique, age, colouring, hair, clothing, materials, posture, notable marks, and the immediate surroundings.',
    'Use only what the material states. Do not add a detail because it is likely or typical — a subject the material does not describe stays undescribed.',
    'Never mention game statistics, plot, names, or anything abstract — a model cannot draw a reputation.',
    'If the material contradicts itself, prefer the most recent and the most specific.',
    'Do not add commentary, headings, or quotation marks: return the paragraph and nothing else.',
].join(' ');

/**
 * The path for a subject with no dossier yet.
 *
 * Kept because a table should be able to generate a picture the day it installs
 * this, before analysing anything — but it is the weaker route, and the UI says
 * so rather than pretending the two are equivalent.
 */
async function buildBriefedPrompt(input: {
    campaignId: number;
    entityType: EntityMediaType;
    entityId: string;
    mode: ImageGenerationMode;
    userPrompt: string;
    style: string;
    shape: ImageShape;
    shot: string;
}): Promise<PortraitPrompt> {
    const { campaignId, entityType, entityId, mode, userPrompt, style, shape, shot } = input;

    const sheet = subjectFacts(campaignId, entityType, entityId);
    if (!sheet) throw new NothingToDrawError('This entity does not exist in this campaign');

    const spoken = await spokenDescriptions(campaignId, sheet.name);

    const sources: Array<'sheet' | 'rag' | 'user'> = [];
    const material: string[] = [];

    if (sheet.facts.length > 0) {
        sources.push('sheet');
        material.push(`What the campaign records about ${sheet.name}:\n${sheet.facts.join('\n')}`);
    }
    if (spoken.length > 0) {
        sources.push('rag');
        material.push(`What was said about them at the table:\n${spoken.map(passage => `- ${passage}`).join('\n')}`);
    }
    if (mode === 'mixed' && userPrompt) {
        sources.push('user');
        material.push(
            `The player asks for this, and it overrides anything above that contradicts it:\n${userPrompt}`,
        );
    }

    if (material.length === 0) {
        throw new NothingToDrawError('There is nothing recorded about this entity to draw from yet');
    }

    const brief = await generateText({
        route: await getMetadataClient(scopeForCampaign(campaignId)),
        label: 'image-prompt',
        system: BRIEF_SYSTEM,
        prompt: material.join('\n\n'),
        temperature: 0.7,
        maxTokens: 400,
    });

    return {
        prompt: [style, brief.content.trim(), shot, NO_INVENTION_RULE, NO_TEXT_RULE].join('\n\n'),
        sources,
        shape,
        usedTextCall: true,
        textUsage: brief.usage,
    };
}

/**
 * What was said out loud about this subject, through the RAG.
 *
 * The weaker half of the fallback: one fixed query returning whatever is most
 * similar. The dossier path replaces it with a run that can follow a subject
 * into their faction and quote the transcript — this remains for subjects
 * nobody has analysed.
 */
async function spokenDescriptions(campaignId: number, name: string): Promise<string[]> {
    try {
        const passages = await searchKnowledge(
            campaignId,
            `physical appearance and description of ${name}`,
            RAG_PASSAGES,
        );
        return passages
            .map(passage => passage.trim())
            .filter(passage => passage !== '')
            .map(passage => passage.slice(0, MAX_PASSAGE_CHARS));
    } catch {
        // A campaign with no index yet, or an embedding node that is off. The
        // sheet alone still makes a usable portrait, and failing the whole
        // request over the optional half would be the wrong trade.
        return [];
    }
}

export type { EntityAppearance };
