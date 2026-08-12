import { useEffect, useState } from 'react';
import { useDialogBehaviour } from './useDialogBehaviour';
import { useT } from '../i18n';

export interface LightboxImage {
    src: string;
    alt: string;
}

/**
 * The entity art, full screen — and all of it, not only the one that was clicked.
 *
 * A portrait is 12rem tall in a sheet and 48px in a list, so this started as the
 * only way to actually look at what had been uploaded. Now that an entity holds
 * several pictures, enlarging one and being unable to reach the others was the
 * same problem one level up: the gallery existed and there was nowhere to see
 * it. Arrow keys, buttons and the dots all move through the set.
 *
 * It borrows the modal's keyboard contract (Escape, focus trap, focus returned)
 * but none of its chrome — a frame with padding around a picture defeats the
 * point of enlarging it.
 */
export function ImageLightbox({
    src,
    alt,
    images,
    open,
    onClose,
}: {
    src: string;
    alt: string;
    /**
     * The whole set, when there is one. `src` stays the picture that was
     * clicked, so a caller with a single image needs to know nothing about
     * galleries.
     */
    images?: LightboxImage[];
    open: boolean;
    onClose: () => void;
}) {
    const t = useT();
    const dialogRef = useDialogBehaviour(open, onClose);
    const all = images && images.length > 0 ? images : [{ src, alt }];
    const opened = Math.max(0, all.findIndex((image) => image.src === src));
    const [index, setIndex] = useState(opened);

    // Reopening on a different picture starts from that picture, not from
    // wherever the last visit left off.
    useEffect(() => {
        if (open) setIndex(opened);
    }, [open, opened]);

    useEffect(() => {
        if (!open || all.length < 2) return;
        function onKey(event: KeyboardEvent) {
            if (event.key === 'ArrowRight') setIndex((current) => (current + 1) % all.length);
            if (event.key === 'ArrowLeft') setIndex((current) => (current - 1 + all.length) % all.length);
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, all.length]);

    if (!open) return null;

    const current = all[Math.min(index, all.length - 1)];
    const many = all.length > 1;

    return (
        <div className="image-lightbox" onClick={onClose}>
            <div
                ref={dialogRef}
                className="image-lightbox__frame"
                role="dialog"
                aria-modal="true"
                aria-label={current.alt || t.media.image}
                onClick={(event) => event.stopPropagation()}
            >
                <button
                    type="button"
                    className="icon-button image-lightbox__close"
                    onClick={onClose}
                    aria-label={t.common.close}
                >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                        <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </button>

                {many && (
                    <button
                        type="button"
                        className="icon-button image-lightbox__step image-lightbox__step--previous"
                        onClick={() => setIndex((value) => (value - 1 + all.length) % all.length)}
                        aria-label={t.media.previousImage}
                    >
                        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                )}

                <img src={current.src} alt={current.alt} />

                {many && (
                    <button
                        type="button"
                        className="icon-button image-lightbox__step image-lightbox__step--next"
                        onClick={() => setIndex((value) => (value + 1) % all.length)}
                        aria-label={t.media.nextImage}
                    >
                        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                            <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                )}

                {many && (
                    <div className="image-lightbox__dots" aria-live="polite">
                        <span className="visually-hidden">{t.media.imageOfMany(index + 1, all.length)}</span>
                        {all.map((image, position) => (
                            <button
                                key={image.src}
                                type="button"
                                className={position === index
                                    ? 'image-lightbox__dot image-lightbox__dot--current'
                                    : 'image-lightbox__dot'}
                                onClick={() => setIndex(position)}
                                aria-label={t.media.imageOfMany(position + 1, all.length)}
                                aria-current={position === index}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
