import type { ReactNode } from 'react';

/**
 * The head of every detail page: picture, kicker, name, badges — and the
 * actions, always in the same corner.
 *
 * It exists because there were eight copies of this markup and they had drifted:
 * two had lost the kicker, the artifact one had its own name for every class,
 * and the edit and delete buttons sat at the *bottom* of the page, below the
 * history, in a bar you had to scroll to find. Where the controls for a thing
 * are should not depend on which kind of thing it is.
 *
 * The layout is a three-column grid — media, copy, actions — so the actions sit
 * top-right on a wide screen and drop under the title on a narrow one, without
 * either being a special case.
 */
export function EntityDetailHeader({
    kicker,
    title,
    subtitle,
    badges,
    media,
    decoration,
    actions,
    className,
    children,
}: {
    kicker: string;
    title: ReactNode;
    subtitle?: ReactNode;
    badges?: ReactNode;
    /** The picture slot, already framed by the caller for its shape. */
    media?: ReactNode;
    /** Purely ornamental, behind everything — the artifact sheet's sigil. */
    decoration?: ReactNode;
    /** Edit, delete: whatever this entity lets someone do to it. */
    actions?: ReactNode;
    className?: string;
    /** Anything the page wants under the badges, such as a cross-reference. */
    children?: ReactNode;
}) {
    return (
        <header className={className ? `entity-detail-header ${className}` : 'entity-detail-header'}>
            {decoration}
            {media}
            <div className="entity-detail-header__copy">
                <span className="campaign-kicker">{kicker}</span>
                <h1>{title}</h1>
                {subtitle && <p className="subtitle">{subtitle}</p>}
                {badges && <div className="badge-row">{badges}</div>}
                {children}
            </div>
            {actions && <div className="entity-detail-header__actions">{actions}</div>}
        </header>
    );
}
