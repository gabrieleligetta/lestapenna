/**
 * The twenty-two major arcana a campaign card can be drawn as.
 *
 * The keys and their order mirror `src/services/tarotArcana.ts` on the server,
 * which is the authority on what may be stored. What lives here is the numeral
 * engraved on the card; its drawing is in `tarotArt.tsx`, kept apart because
 * this file is imported by the API types and a type import should not drag
 * twenty-two SVGs behind it.
 */
export const TAROT_ARCANA = [
    { key: 'fool', numeral: '0' },
    { key: 'magician', numeral: 'I' },
    { key: 'high_priestess', numeral: 'II' },
    { key: 'empress', numeral: 'III' },
    { key: 'emperor', numeral: 'IV' },
    { key: 'hierophant', numeral: 'V' },
    { key: 'lovers', numeral: 'VI' },
    { key: 'chariot', numeral: 'VII' },
    { key: 'strength', numeral: 'VIII' },
    { key: 'hermit', numeral: 'IX' },
    { key: 'wheel_of_fortune', numeral: 'X' },
    { key: 'justice', numeral: 'XI' },
    { key: 'hanged_man', numeral: 'XII' },
    { key: 'death', numeral: 'XIII' },
    { key: 'temperance', numeral: 'XIV' },
    { key: 'devil', numeral: 'XV' },
    { key: 'tower', numeral: 'XVI' },
    { key: 'star', numeral: 'XVII' },
    { key: 'moon', numeral: 'XVIII' },
    { key: 'sun', numeral: 'XIX' },
    { key: 'judgement', numeral: 'XX' },
    { key: 'world', numeral: 'XXI' },
] as const;

export type TarotArcanum = (typeof TAROT_ARCANA)[number]['key'];

export interface TarotCardFace {
    key: TarotArcanum;
    numeral: string;
}

const BY_KEY = new Map<string, TarotCardFace>(
    TAROT_ARCANA.map((card) => [card.key, card as TarotCardFace]),
);

/**
 * The face of one arcanum.
 *
 * An unknown key falls back to the Fool rather than to nothing: a card added
 * on the server before this file learns about it should still be a card, not a
 * hole in the shelf.
 */
export function tarotFace(key: string | null | undefined): TarotCardFace {
    return BY_KEY.get(key ?? '') ?? (TAROT_ARCANA[0] as TarotCardFace);
}
