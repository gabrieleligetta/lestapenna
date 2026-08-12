import { useEffect, useState } from 'react';
import type { EntityImage, MediaEntityType } from '../api/types';
import { useEntityImages } from '../api/hooks';
import { Icon, type IconName } from './icons';
import { ImageLightbox } from './ImageLightbox';
import { useT } from '../i18n';

/**
 * Stable media slot for entity art. The fallback is part of the component, so
 * detail pages never jump or show a broken-image glyph while media is absent.
 *
 * The picture opens full screen on click: at 12rem tall it is a thumbnail of
 * itself, and there was no other way to look at what had been uploaded.
 */
export function EntityMedia({
    image,
    icon,
    shape = 'portrait',
    campaignId,
    entityType,
    entityId,
}: {
    image?: EntityImage | null;
    icon: IconName;
    shape?: 'portrait' | 'landscape' | 'square';
    /**
     * The entity this picture belongs to.
     *
     * Given, the slot fetches the rest of its gallery so enlarging one picture
     * opens all of them. Omitted, it behaves exactly as it did — a card in a
     * list has no business loading a gallery nobody asked to see.
     */
    campaignId?: string;
    entityType?: MediaEntityType;
    entityId?: string;
}) {
    const t = useT();
    const [broken, setBroken] = useState(false);
    const [zoomed, setZoomed] = useState(false);
    // Only once somebody has actually enlarged something: the sheet should not
    // pay for the gallery of every entity it renders.
    const gallery = useEntityImages(
        campaignId ?? '',
        entityType ?? 'npc',
        zoomed && campaignId && entityId ? entityId : '',
    );

    useEffect(() => {
        setBroken(false);
    }, [image?.displayUrl]);

    return (
        <div
            className={`entity-media entity-media--${shape}`}
            style={image ? {
                '--entity-focal-x': `${image.focalX ?? 50}%`,
                '--entity-focal-y': `${image.focalY ?? 50}%`,
            } as React.CSSProperties : undefined}
        >
            {image && !broken ? (
                <>
                    <button
                        type="button"
                        className="entity-media__zoom"
                        onClick={() => setZoomed(true)}
                        aria-label={t.media.enlarge}
                    >
                        <img
                            src={image.displayUrl}
                            alt={image.altText ?? ''}
                            width={image.width}
                            height={image.height}
                            loading="lazy"
                            decoding="async"
                            onError={() => setBroken(true)}
                        />
                    </button>
                    <ImageLightbox
                        src={image.displayUrl}
                        alt={image.altText ?? ''}
                        images={(gallery.data ?? []).map((picture) => ({
                            src: picture.displayUrl,
                            alt: picture.altText ?? '',
                        }))}
                        open={zoomed}
                        onClose={() => setZoomed(false)}
                    />
                </>
            ) : (
                <span className="entity-media__fallback" aria-hidden="true">
                    <Icon name={icon} />
                </span>
            )}
        </div>
    );
}

export function EntityThumbnail({
    image,
    icon,
    shape = 'square',
    /**
     * Opt-in, because most thumbnails live inside the link that opens the
     * entity: a button nested in that link is invalid markup and would steal a
     * click whose obvious meaning is "take me to the sheet".
     */
    zoomable = false,
}: {
    image?: EntityImage | null;
    icon: IconName;
    shape?: 'portrait' | 'landscape' | 'square';
    zoomable?: boolean;
}) {
    const t = useT();
    const [broken, setBroken] = useState(false);
    const [zoomed, setZoomed] = useState(false);

    useEffect(() => {
        setBroken(false);
    }, [image?.thumbnailUrl]);

    const picture = image && !broken ? (
        <img
            src={image.thumbnailUrl}
            alt=""
            width="48"
            height="48"
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
        />
    ) : (
        <Icon name={icon} />
    );

    // A decorative thumbnail is hidden from assistive tech; a zoomable one is a
    // control and has to be reachable.
    if (!zoomable || !image || broken) {
        return (
            <span
                className={`entity-thumbnail entity-thumbnail--${shape}`}
                style={focalStyle(image)}
                aria-hidden="true"
            >
                {picture}
            </span>
        );
    }

    return (
        <>
            <button
                type="button"
                className={`entity-thumbnail entity-thumbnail--${shape} entity-thumbnail--zoomable`}
                style={focalStyle(image)}
                onClick={() => setZoomed(true)}
                aria-label={t.media.enlarge}
            >
                {picture}
            </button>
            <ImageLightbox
                // The thumbnail is 48px: enlarging it must show the display
                // variant, not a blown-up 48px square.
                src={image.displayUrl}
                alt={image.altText ?? ''}
                open={zoomed}
                onClose={() => setZoomed(false)}
            />
        </>
    );
}

function focalStyle(image?: EntityImage | null): React.CSSProperties | undefined {
    if (!image) return undefined;
    return {
        '--entity-focal-x': `${image.focalX ?? 50}%`,
        '--entity-focal-y': `${image.focalY ?? 50}%`,
    } as React.CSSProperties;
}
