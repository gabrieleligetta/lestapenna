import type { TarotArcanum } from './tarot';

/**
 * The picture on each of the twenty-two major arcana.
 *
 * A numeral and a planetary sign name a card; they do not show one. Nobody
 * recognises the Tower from «XVI», and a shelf of campaigns that differ only by
 * a roman numeral is a shelf of identical cards. So each arcanum has its own
 * drawing — the motif the deck is actually known by: the struck tower, the
 * scales, the wheel, the two towers of the Moon.
 *
 * Line art in the same language as `icons.tsx` — one stroke weight, no fills
 * beyond a few accents, `currentColor` throughout — so a card can tint its
 * drawing with its own gilt and the same file serves the 7rem medallion and the
 * 1.4rem tile in the picker. Twenty-two inline drawings rather than an image
 * per card: they must work in both themes, at both sizes, offline, and with no
 * request that could fail.
 */

const STROKE = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
} as const;

const ART: Record<TarotArcanum, React.ReactNode> = {
    // The knapsack on its staff, at the edge of the cliff.
    fool: (
        <>
            <path d="M13 47 L31 19" />
            <path d="M31 14a4 4 0 1 1 4 6 4 4 0 0 1-4-6z" />
            <path d="M7 47h13v9" />
            <circle cx="24" cy="47" r="2.4" />
        </>
    ),
    // The lemniscate over the raised wand.
    magician: (
        <>
            <path d="M17 22c-4 0-6 2.6-6 5s2 5 6 5 6-10 10-10 6 2.6 6 5-2 5-6 5-6-10-10-10z" />
            <path d="M24 36v14" />
            <path d="M16 50h16" />
        </>
    ),
    // The crescent between her two pillars.
    high_priestess: (
        <>
            <path d="M13 18v30M35 18v30" />
            <path d="M10 18h6M32 18h6" />
            <path d="M28 33a6.5 6.5 0 1 1-6-9 8 8 0 0 0 6 9z" />
        </>
    ),
    // Crown and the sign of Venus.
    empress: (
        <>
            <path d="M15 26l-2-8 5 4 6-7 6 7 5-4-2 8z" />
            <path d="M15 30h18" />
            <circle cx="24" cy="41" r="5" />
            <path d="M24 46v8M20.5 50h7" />
        </>
    ),
    // The squared throne.
    emperor: (
        <>
            <path d="M14 24v22M34 24v22" />
            <path d="M14 24a4 4 0 0 1 8 0M26 24a4 4 0 0 1 8 0" />
            <path d="M14 34h20" />
            <path d="M11 46h26" />
            <circle cx="24" cy="28" r="2.6" />
        </>
    ),
    // The triple tiara over the crossed keys.
    hierophant: (
        <>
            <path d="M17 26a7 7 0 0 1 14 0M15.5 32a8.5 8.5 0 0 1 17 0M14 38h20" />
            <path d="M18 42l12 10M30 42L18 52" />
            <circle cx="17.2" cy="41.2" r="1.8" />
            <circle cx="30.8" cy="41.2" r="1.8" />
        </>
    ),
    // Two under the arch.
    lovers: (
        <>
            <path d="M10 26a14 14 0 0 1 28 0" />
            <circle cx="18" cy="34" r="4" />
            <circle cx="30" cy="34" r="4" />
            <path d="M12 50a6.5 6.5 0 0 1 12 0M24 50a6.5 6.5 0 0 1 12 0" />
        </>
    ),
    // The car, its canopy of stars, its two wheels.
    chariot: (
        <>
            <path d="M13 30h22v12H13z" />
            <path d="M15 30l3-8h12l3 8" />
            <circle cx="17" cy="47" r="5" />
            <circle cx="31" cy="47" r="5" />
            <path d="M24 22v-5" />
        </>
    ),
    // The lion.
    strength: (
        <>
            <circle cx="24" cy="34" r="9" />
            <path d="M24 25l-2-6 5 3 5-4-1 6M24 25l2-6-5 3-5-4 1 6" />
            <path d="M20 32.5h.01M28 32.5h.01" />
            <path d="M21 40a4 4 0 0 0 6 0" />
            <path d="M13 44l-4 4M35 44l4 4" />
        </>
    ),
    // The lantern on its staff.
    hermit: (
        <>
            <path d="M20 24h10l4 7-4 7H20l-4-7z" />
            <path d="M25 24v-4M22 20h6" />
            <path d="M25 31h.01" />
            <path d="M14 52L34 20" />
        </>
    ),
    // The wheel.
    wheel_of_fortune: (
        <>
            <circle cx="24" cy="34" r="14" />
            <circle cx="24" cy="34" r="4" />
            <path d="M24 20v6M24 42v6M10 34h6M32 34h6M14.1 24.1l4.3 4.3M29.6 39.6l4.3 4.3M33.9 24.1l-4.3 4.3M18.4 39.6l-4.3 4.3" />
        </>
    ),
    // The scales.
    justice: (
        <>
            <path d="M24 18v30M17 48h14" />
            <path d="M11 26h26" />
            <path d="M5 26l6 10 6-10" />
            <path d="M31 26l6 10 6-10" />
        </>
    ),
    // Hung by one heel from the beam.
    hanged_man: (
        <>
            <path d="M10 18h28M24 18v8" />
            <circle cx="24" cy="46" r="4.5" />
            <path d="M24 26v15" />
            <path d="M24 30l-7 5M24 30l7 5" />
        </>
    ),
    // The scythe.
    death: (
        <>
            <path d="M13 51L33 21" />
            <path d="M33 21c-9-3-17 1-20 8 8 2 16-1 20-8z" />
            <path d="M17 45l6 4" />
        </>
    ),
    // Water poured from cup to cup.
    temperance: (
        <>
            <path d="M9 22h11l-1.5 9a4 4 0 0 1-8 0z" />
            <path d="M28 38h11l-1.5 9a4 4 0 0 1-8 0z" />
            <path d="M19 33c4 2 6 4 9 8" />
            <path d="M14.5 44v4M33.5 22v-4" />
        </>
    ),
    // Horns over the reversed star.
    devil: (
        <>
            <path d="M14 26c-1-5 0-8 2-10 1 4 3 6 5 7M34 26c1-5 0-8-2-10-1 4-3 6-5 7" />
            <path d="M13 28h22L24 48z" />
            <path d="M20 33h.01M28 33h.01" />
        </>
    ),
    // Struck by the bolt, and coming apart.
    tower: (
        <>
            <path d="M15 56V19h3v3h4v-3h4v3h4v-3h3v37z" />
            <path d="M12 56h24" />
            <path d="M22 33h4v7h-4z" />
            <path d="M22 56v-6a2 2 0 0 1 4 0v6" />
            <path d="M34 3l-6 9h5l-4 7" />
            <path d="M9 30l-4-3M40 34l4-3" />
        </>
    ),
    // The star over the poured water.
    star: (
        <>
            <path d="M24 14l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" />
            <path d="M14 42c3-3 6-3 9 0M25 46c3-3 6-3 9 0" />
            <path d="M12 50c3-3 6-3 9 0M27 52c3-3 6-3 9 0" />
        </>
    ),
    // The crescent between the two towers, and the road between them.
    moon: (
        <>
            <path d="M30 30a8 8 0 1 1-7-11 10 10 0 0 0 7 11z" />
            <path d="M12 50V38l3-4 3 4v12M30 50V38l3-4 3 4v12" />
            <path d="M24 40v12" />
        </>
    ),
    // The sun.
    sun: (
        <>
            <circle cx="24" cy="34" r="9" />
            <path d="M24 17v5M24 46v5M7 34h5M36 34h5M12.5 22.5l3.5 3.5M32 42l3.5 3.5M35.5 22.5L32 26M16 42l-3.5 3.5" />
        </>
    ),
    // The trumpet, and the sound of it.
    judgement: (
        <>
            <path d="M12 34l18-8v16z" />
            <path d="M30 30h6v8h-6" />
            <path d="M40 28a10 10 0 0 1 0 12M43 24a15 15 0 0 1 0 20" />
            <path d="M17 40v8" />
        </>
    ),
    // The wreath, closed at last.
    world: (
        <>
            <path d="M24 15c7 0 12 8.5 12 19s-5 19-12 19-12-8.5-12-19 5-19 12-19z" />
            <path d="M24 26l2.5 5.5L32 34l-5.5 2.5L24 42l-2.5-5.5L16 34l5.5-2.5z" />
            <path d="M18 14l4 3M30 14l-4 3M18 54l4-3M30 54l-4-3" />
        </>
    ),
};

/**
 * The drawing of one arcanum.
 *
 * Decorative by default: the card already names its arcanum in words next to
 * it, so repeating that name to a screen reader would only make it read every
 * card twice.
 */
export function TarotArt({ arcanum, className }: { arcanum: TarotArcanum; className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 48 64"
            aria-hidden="true"
            focusable="false"
            {...STROKE}
        >
            {ART[arcanum]}
        </svg>
    );
}
