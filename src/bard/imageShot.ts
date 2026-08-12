/**
 * How the picture should be taken, as opposed to what is in it.
 *
 * The dossier answers «what does this subject look like»; none of it answers
 * «how close, from where, in what light». Those were buried in one style
 * sentence that said *head and shoulders* whatever anyone wanted, which is why
 * every portrait came out the same bust — a lot of work to establish that a
 * character wears a long gown, and then a picture that stops above it.
 *
 * Closed sets rather than free text on purpose. They are localisable, they
 * cannot contradict each other, and each maps to one phrase a model reliably
 * understands. Anything outside them still goes in the person's own prompt,
 * which is the right place for the unusual request.
 */

import type { SubjectKind } from './entityFacts';

export const SHOT_FRAMINGS = ['face', 'bust', 'half', 'full', 'wide', 'detail'] as const;
export type ShotFraming = typeof SHOT_FRAMINGS[number];

export const SHOT_POSES = ['frontal', 'three_quarter', 'profile', 'back', 'action', 'seated'] as const;
export type ShotPose = typeof SHOT_POSES[number];

export const SHOT_LIGHTS = ['soft', 'dramatic', 'backlit', 'candlelight', 'daylight', 'night'] as const;
export type ShotLight = typeof SHOT_LIGHTS[number];

export const SHOT_BACKGROUNDS = ['neutral', 'location', 'dark', 'light'] as const;
export type ShotBackground = typeof SHOT_BACKGROUNDS[number];

export interface ImageShot {
    framing?: ShotFraming | null;
    pose?: ShotPose | null;
    light?: ShotLight | null;
    background?: ShotBackground | null;
}

/**
 * Which framings make sense for which subject.
 *
 * A tavern has no bust and a sword has no pose; offering the word invites a
 * picture that tries to honour it.
 */
export const FRAMINGS_BY_KIND: Record<SubjectKind, readonly ShotFraming[]> = {
    person: ['face', 'bust', 'half', 'full'],
    place: ['wide', 'detail'],
    object: ['full', 'detail'],
};

/** What the person sees if they change nothing — today's behaviour, made explicit. */
export const DEFAULT_SHOT: Record<SubjectKind, {
    framing: ShotFraming;
    light: ShotLight;
    background: ShotBackground;
}> = {
    person: { framing: 'bust', light: 'soft', background: 'neutral' },
    place: { framing: 'wide', light: 'daylight', background: 'location' },
    object: { framing: 'full', light: 'soft', background: 'neutral' },
};

const FRAMING_PHRASE: Record<ShotFraming, string> = {
    face: 'Framing: a close-up of the face and head only.',
    bust: 'Framing: head and shoulders.',
    half: 'Framing: from the waist up, showing what is worn on the upper body.',
    full: 'Framing: the whole figure from head to foot, nothing cropped.',
    wide: 'Framing: a wide shot that takes in the whole place.',
    detail: 'Framing: a close view of one telling detail.',
};

const POSE_PHRASE: Record<ShotPose, string> = {
    frontal: 'Pose: facing the viewer squarely.',
    three_quarter: 'Pose: turned three-quarters towards the viewer.',
    profile: 'Pose: seen in profile, from the side.',
    back: 'Pose: seen from behind, looking away.',
    action: 'Pose: caught mid-movement, weight off centre.',
    seated: 'Pose: seated.',
};

const LIGHT_PHRASE: Record<ShotLight, string> = {
    soft: 'Lighting: soft and diffuse, gentle shadows.',
    dramatic: 'Lighting: hard and directional, deep shadows.',
    backlit: 'Lighting: from behind, the subject rimmed with light.',
    candlelight: 'Lighting: warm candlelight from below.',
    daylight: 'Lighting: open daylight.',
    night: 'Lighting: night, little light and cold colour.',
};

const BACKGROUND_PHRASE: Record<ShotBackground, string> = {
    neutral: 'Background: plain and neutral, nothing competing with the subject.',
    location: 'Background: the place this belongs to, suggested rather than detailed.',
    dark: 'Background: a plain dark ground.',
    light: 'Background: a plain pale ground.',
};

/**
 * The shot as instructions, in a fixed order.
 *
 * Emitted even when nothing was chosen: the defaults are the behaviour the
 * product already had, and stating them beats leaving a model to guess a
 * framing it will then guess differently next time.
 */
export function shotLines(kind: SubjectKind, shot: ImageShot | null | undefined): string[] {
    const defaults = DEFAULT_SHOT[kind];
    const framing = pick(shot?.framing, FRAMINGS_BY_KIND[kind]) ?? defaults.framing;
    const light = pick(shot?.light, SHOT_LIGHTS) ?? defaults.light;
    const background = pick(shot?.background, SHOT_BACKGROUNDS) ?? defaults.background;
    // A pose only exists for somebody who can hold one.
    const pose = kind === 'person' ? pick(shot?.pose, SHOT_POSES) : null;

    return [
        FRAMING_PHRASE[framing],
        ...(pose ? [POSE_PHRASE[pose]] : []),
        LIGHT_PHRASE[light],
        BACKGROUND_PHRASE[background],
    ];
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? value as T
        : null;
}
