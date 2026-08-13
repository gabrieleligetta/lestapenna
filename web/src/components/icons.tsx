/**
 * Inline SVG glyphs, hand-rolled instead of pulling an icon package.
 *
 * A library costs 50-200KB for the ~18 shapes used here, and its icons paint
 * with their own colours rather than inheriting the theme tokens. These are
 * stroke-only on `currentColor`, so they follow the text colour in both themes
 * for free.
 */

const PATHS = {
    overview: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    party: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M17 10.5a3 3 0 1 0 0-6M18 20h3.5a5.5 5.5 0 0 0-4-5.3',
    characters: 'M12 3l7 3v6c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6z',
    npcs: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
    locations: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM12 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    factions: 'M5 21V4M5 4h11l-2 3.5L16 11H5',
    quests: 'M6 4h12v16H6zM9.5 9h5M9.5 13h5M9.5 17h3',
    inventory: 'M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8',
    artifacts: 'M6 3h12l3 6-9 12L3 9zM3 9h18',
    bestiary: 'M12 3a8 8 0 0 0-8 8v3l2 1v3h12v-3l2-1v-3a8 8 0 0 0-8-8zM9 11.5h.01M15 11.5h.01',
    timeline: 'M6 3v18M6 7h.01M6 12h.01M6 17h.01M10 7h8M10 12h8M10 17h8',
    sessions: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
    servers: 'M4 20V9l8-5 8 5v11M9.5 20v-6h5v6',
    menu: 'M4 7h16M4 12h16M4 17h16',
    close: 'M6 6l12 12M18 6L6 18',
    system: 'M4 5h16v10H4zM9 19h6M12 15v4',
    light: 'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2v2M12 20v2M2 12h2M20 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4',
    dark: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
    loading: 'M21 12a9 9 0 1 1-5.3-8.2',
    empty: 'M4 7h16v13H4zM8 7V4h8v3M8 12h8M10 16h4',
    error: 'M12 3 2.8 20h18.4zM12 9v4M12 17h.01',
    check: 'M5 12l4 4L19 6',
    progress: 'M12 3a9 9 0 1 1-9 9M12 7v5l3 2',
    open: 'M4 6h16v14H4zM8 3v6M16 3v6',
    failed: 'M6 6l12 12M18 6 6 18',
    sealed: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z',
    dormant: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
    lost: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM9.8 8.2A2.4 2.4 0 0 1 12 7c1.4 0 2.5.9 2.5 2.2 0 2-2.5 2-2.5 3.4M12 16h.01',
    skull: 'M12 3a8 8 0 0 0-8 8v3l2 1v3h12v-3l2-1v-3a8 8 0 0 0-8-8zM9 11.5h.01M15 11.5h.01M10 16v2M14 16v2',
    flame: 'M13.5 3s.8 3.1-1.7 5.2c-1.4 1.2-2.6 2.4-2.6 4.5 0 1.8 1.2 3.3 2.8 3.3 2.2 0 3.7-1.8 3.7-4.2 0-1.5-.5-2.8-1.3-4 2.9 1.7 4.6 4.3 4.6 7.1A7.4 7.4 0 0 1 12 22a7.4 7.4 0 0 1-7.4-7.1c0-4.5 3.4-7.8 8.9-11.9z',
    sparkles: 'M12 2l1.2 4.1L17 8l-3.8 1.9L12 14l-1.2-4.1L7 8l3.8-1.9zM19 14l.7 2.3L22 17.5l-2.3 1.2L19 21l-.7-2.3-2.3-1.2 2.3-1.2zM5 13l.6 2L7.5 16l-1.9 1L5 19l-.6-2-1.9-1 1.9-1z',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    calendar: 'M4 6h16v14H4zM8 3v6M16 3v6M4 10h16',
    owner: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    war: 'M6 4l12 16M18 4 6 16M4 7h4M16 7h4M4 17h4M16 17h4',
    politics: 'M5 20V9l7-5 7 5v11M2 20h20M9 12v5M15 12v5',
    discovery: 'M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3zM9 22h6M9 12h6',
    calamity: 'M12 3 2.8 20h18.4zM12 8v5M12 17h.01',
    supernatural: 'M12 3l2.2 5.2L20 10l-4.5 3.7.3 5.8L12 17l-3.8 2.5.3-5.8L4 10l5.8-1.8z',
    religion: 'M12 3v18M7 8h10M6 21h12',
    myth: 'M4 19c3-5 5-7 8-7s5 2 8 7M7 9c0-3 2-6 5-6s5 3 5 6M9 9h6',
    death: 'M12 3a8 8 0 0 0-8 8v3l2 1v3h12v-3l2-1v-3a8 8 0 0 0-8-8zM9 11.5h.01M15 11.5h.01',
    generic: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
    birth: 'M12 4v16M4 12h16M6.5 6.5l11 11M17.5 6.5l-11 11',
    construction: 'M4 20h16M6 20V9l6-5 6 5v11M9 20v-6h6v6',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
    weapon: 'M14 4l6-2-2 6-8 8-3-3 7-9zM5 15l4 4M3 21l4-2-2-2z',
    armor: 'M12 3l7 3v6c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6zM9 8h6M9 12h6',
    potion: 'M9 3h6M10 3v5l-4.5 7.5A3.5 3.5 0 0 0 8.5 21h7a3.5 3.5 0 0 0 3-5.5L14 8V3M7 15h10',
    tool: 'M14 6a4 4 0 0 0-5 5L3 17l4 4 6-6a4 4 0 0 0 5-5l-3 1-2-2 1-3z',
    material: 'M12 3 4 8v8l8 5 8-5V8zM4 8l8 5 8-5M12 13v8',
    treasure: 'M4 9h16v11H4zM7 9V6h10v3M4 13h16M11 13v3h2v-3',
    questItem: 'M6 4h12v16H6zM9 9h6M9 13h4M15 16l1.5 1.5L20 14',
    logout: 'M10 4H4v16h6M14 8l4 4-4 4M18 12H8',
    arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
    arrowRight: 'M5 12h14M13 6l6 6-6 6',
    flag: 'M5 21V4M5 4h12l-2.5 3.5L17 11H5',
    screen: 'M4 5h16v10H4zM9 19h6M12 15v4M15 8h3v3',
    crop: 'M6 2v16h16M2 6h16v16',
    pen: 'M12 2l4 4-9 13-4 1 1-4zM12 7l3 3',
    arrow: 'M5 19L19 5M19 5h-7M19 5v7',
    rect: 'M5 5h14v14H5z',
    highlight: 'M4 18l2-2 7-7 4 4-7 7-2 2zM14 6l4 4M17 3l4 4',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    coins: 'M20 6c0 1.7-3.6 3-8 3S4 7.7 4 6s3.6-3 8-3 8 1.3 8 3zM4 6v4c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 10v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4M4 14v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4',
    trash: 'M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6',
    plus: 'M12 5v14M5 12h14',
    bell: 'M12 3a6 6 0 0 0-6 6c0 3.5-1 5-2 6h16c-1-1-2-2.5-2-6a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0',
    memory: 'M9 4a4 4 0 0 0-4 4 3 3 0 0 0-1 5.8A3.5 3.5 0 0 0 7.5 20 3.5 3.5 0 0 0 11 16.5V6a2 2 0 0 0-2-2zM15 4a4 4 0 0 1 4 4 3 3 0 0 1 1 5.8A3.5 3.5 0 0 1 16.5 20 3.5 3.5 0 0 1 13 16.5V6a2 2 0 0 1 2-2z',
    heart: 'M12 20.5 4.3 13a4.8 4.8 0 0 1 6.8-6.8l.9.9.9-.9A4.8 4.8 0 0 1 19.7 13z',
} as const;

export type IconName = keyof typeof PATHS;

/**
 * Platform marks, kept apart from {@link PATHS} on purpose.
 *
 * Everything above is stroke-only on `currentColor`, which is what lets one
 * glyph work in both themes without a second copy. A brand mark cannot play by
 * that rule: GitHub's and Ko-fi's are **filled** shapes, and outlining them
 * makes them unrecognisable — which defeats the only reason to show them, that
 * a reader can tell where the button is about to send them before clicking.
 *
 * So they get their own map, their own fill-based component, and no place in
 * `IconName`. Nominative use of a platform's own mark to link to that platform
 * is exactly what both of them publish brand assets for.
 */
const BRAND_PATHS = {
    github: 'M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.17c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z',
    // The Ko-fi cup: saucer, body, and the handle that makes it read as a cup
    // rather than a mug at 16px, which is the size this actually renders at.
    kofi: 'M4 4h13a4 4 0 0 1 0 8h-1.1a6.5 6.5 0 0 1-6.4 5.5H8A4 4 0 0 1 4 13.5zm11.9 6H17a2 2 0 0 0 0-4h-1.1zM3 19.5h15a1 1 0 0 1 0 2H3a1 1 0 0 1 0-2z',
} as const;

export type BrandName = keyof typeof BRAND_PATHS;

/** A platform's own mark, filled and inheriting `currentColor`. */
export function BrandIcon({ name, className }: { name: BrandName; className?: string }) {
    return (
        <svg
            className={className ? `brand-icon ${className}` : 'brand-icon'}
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
            aria-hidden="true"
            focusable="false"
        >
            <path d={BRAND_PATHS[name]} />
        </svg>
    );
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
    return (
        <svg
            className={className ? `icon ${className}` : 'icon'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <path d={PATHS[name]} />
        </svg>
    );
}
