import type { Campaign } from '../db/types';

/**
 * The twenty-two major arcana, in their traditional order.
 *
 * A campaign's card is one of these. Keys rather than numbers because a stored
 * `13` says nothing to whoever reads the row, and because the order of the
 * major arcana is a convention this table does not get to renumber.
 */
export const TAROT_ARCANA = [
    'fool',
    'magician',
    'high_priestess',
    'empress',
    'emperor',
    'hierophant',
    'lovers',
    'chariot',
    'strength',
    'hermit',
    'wheel_of_fortune',
    'justice',
    'hanged_man',
    'death',
    'temperance',
    'devil',
    'tower',
    'star',
    'moon',
    'sun',
    'judgement',
    'world',
] as const;

export type TarotArcanum = (typeof TAROT_ARCANA)[number];

export function isTarotArcanum(value: unknown): value is TarotArcanum {
    return typeof value === 'string' && (TAROT_ARCANA as readonly string[]).includes(value);
}

/** A card nobody has chosen yet: the draw happens once, when the campaign is created. */
export function drawTarotArcanum(): TarotArcanum {
    return TAROT_ARCANA[Math.floor(Math.random() * TAROT_ARCANA.length)];
}

/**
 * The card a campaign shows, chosen or drawn.
 *
 * Campaigns created before the column existed have no stored card, and the
 * fallback has to be stable: a fresh random pick on every read would reshuffle
 * the shelf each time the page loaded. It is derived from the id through a
 * multiplicative hash so that neighbouring campaigns do not come out as
 * neighbouring arcana.
 */
export function resolveTarotArcanum(campaign: Pick<Campaign, 'id' | 'tarot_arcana'>): TarotArcanum {
    if (isTarotArcanum(campaign.tarot_arcana)) return campaign.tarot_arcana;
    const scrambled = Math.abs(Math.imul(campaign.id, 2654435761));
    return TAROT_ARCANA[scrambled % TAROT_ARCANA.length];
}
