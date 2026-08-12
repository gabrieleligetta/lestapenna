/**
 * The breakpoints JS needs to know about, mirroring the `min-width` values
 * declared at the top of App.css.
 *
 * They are duplicated on purpose: custom properties are not valid inside a
 * media query, so there is no way to declare them once and read them from both
 * sides. Change one, change the other.
 */
export const BREAKPOINTS = {
    /** Phone → small tablet: tables stop being cards. */
    sm: 640,
    /** The sidebar stops being a drawer and becomes a persistent column. */
    lg: 1024,
    /** The reader has enough content width for a real two-page spread beside the sidebar. */
    xl: 1280,
} as const;

export const MEDIA = {
    sm: `(min-width: ${BREAKPOINTS.sm}px)`,
    lg: `(min-width: ${BREAKPOINTS.lg}px)`,
    xl: `(min-width: ${BREAKPOINTS.xl}px)`,
} as const;
