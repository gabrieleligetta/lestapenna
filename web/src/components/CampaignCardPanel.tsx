import { useEffect, useRef, useState } from 'react';
import { useCampaignCover } from '../api/hooks';
import { useT } from '../i18n';
import { ConfirmModal } from './ConfirmModal';
import { FormFeedback } from './FormFeedback';
import { TAROT_ARCANA, tarotFace, type TarotArcanum } from './tarot';
import { TarotArt } from './tarotArt';

/**
 * The face a campaign shows on the shelf: its arcanum and its cover picture.
 *
 * Both are chosen here rather than on the card itself. A card in a list is a
 * link — the whole of it — and hanging edit controls inside a link is how you
 * end up with a button nobody can reach with a keyboard, so the shelf stays
 * something you look at and this panel is where it is set.
 *
 * The arcanum saves on click. There is nothing to review before committing to a
 * picture on a card, and a Save button under a grid of twenty-two options would
 * only be a second thing to forget.
 */
export function CampaignCardPanel({
    campaignId,
    campaignName,
    arcanum,
    coverUrl,
    readOnly,
    busy,
    onChooseArcanum,
}: {
    campaignId: string;
    campaignName: string;
    arcanum: TarotArcanum;
    coverUrl: string | null;
    readOnly: boolean;
    busy: boolean;
    onChooseArcanum: (arcanum: TarotArcanum) => Promise<unknown>;
}) {
    const t = useT();
    const cover = useCampaignCover(campaignId);
    const fileInput = useRef<HTMLInputElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [removing, setRemoving] = useState(false);
    // Shown while the upload is in flight, so the medallion changes at the
    // moment the file is chosen rather than a round trip later.
    const [preview, setPreview] = useState<string | null>(null);

    useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

    const disabled = readOnly || busy || cover.busy;
    const face = tarotFace(arcanum);
    const shownCover = preview ?? coverUrl;

    async function choose(next: TarotArcanum) {
        if (next === arcanum) return;
        setError(null);
        setSaved(false);
        try {
            await onChooseArcanum(next);
            setSaved(true);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        }
    }

    async function uploadCover(file: File | null) {
        if (!file) return;
        setError(null);
        setSaved(false);
        const objectUrl = URL.createObjectURL(file);
        setPreview((current) => {
            if (current) URL.revokeObjectURL(current);
            return objectUrl;
        });
        try {
            await cover.upload(file);
            setSaved(true);
        } catch (reason) {
            setPreview(null);
            URL.revokeObjectURL(objectUrl);
            setError(reason instanceof Error ? reason.message : t.common.error);
        } finally {
            if (fileInput.current) fileInput.current.value = '';
        }
    }

    async function removeCover() {
        setRemoving(false);
        setError(null);
        setSaved(false);
        try {
            await cover.remove();
            setPreview((current) => {
                if (current) URL.revokeObjectURL(current);
                return null;
            });
            setSaved(true);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        }
    }

    return (
        <section className="settings-section campaign-card-panel">
            <h2>{t.tarot.sectionTitle}</h2>
            <p className="settings-hint">{t.tarot.sectionIntro}</p>

            <div className="campaign-card-panel__layout">
                <div className="campaign-card-panel__preview">
                    <span className={`tarot-chip tarot-chip--${Math.abs(Number(campaignId)) % 6}`}>
                        <span className="tarot-chip__numeral">{face.numeral}</span>
                        <span className="tarot-chip__medallion">
                            {shownCover ? (
                                <img src={shownCover} alt={t.tarot.coverAlt(campaignName)} />
                            ) : (
                                <TarotArt className="tarot-chip__art" arcanum={face.key} />
                            )}
                        </span>
                        <span className="tarot-chip__title">{campaignName}</span>
                        <span className="tarot-chip__arcanum">{t.tarot.arcana[face.key]}</span>
                    </span>

                    <div className="campaign-card-panel__cover-actions">
                        <label className="campaign-card-panel__choose">
                            <span>{coverUrl ? t.tarot.replaceCover : t.tarot.chooseCover}</span>
                            <input
                                ref={fileInput}
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                disabled={disabled}
                                onChange={(event) => void uploadCover(event.currentTarget.files?.[0] ?? null)}
                            />
                        </label>
                        {coverUrl && (
                            <button
                                type="button"
                                className="danger-button"
                                disabled={disabled}
                                onClick={() => setRemoving(true)}
                            >
                                {t.tarot.removeCover}
                            </button>
                        )}
                    </div>
                    <small className="settings-hint">{t.tarot.coverHint}</small>
                </div>

                <div
                    className="campaign-card-panel__deck"
                    role="radiogroup"
                    aria-label={t.tarot.arcanumLabel}
                >
                    {TAROT_ARCANA.map((card) => (
                        <label
                            key={card.key}
                            className={`tarot-option${card.key === arcanum ? ' is-chosen' : ''}`}
                        >
                            <input
                                type="radio"
                                name={`tarot-arcanum-${campaignId}`}
                                value={card.key}
                                checked={card.key === arcanum}
                                disabled={disabled}
                                onChange={() => void choose(card.key)}
                            />
                            <span className="tarot-option__numeral">{card.numeral}</span>
                            <TarotArt className="tarot-option__art" arcanum={card.key} />
                            <span className="tarot-option__name">{t.tarot.arcana[card.key]}</span>
                        </label>
                    ))}
                </div>
            </div>

            <FormFeedback error={error} saved={saved} savedLabel={t.tarot.coverSaved} />

            <ConfirmModal
                open={removing}
                title={t.tarot.removeCover}
                question={t.tarot.removeCoverConfirm}
                busy={cover.busy}
                confirmLabel={t.tarot.removeCover}
                busyLabel={t.common.loading}
                onClose={() => setRemoving(false)}
                onConfirm={() => void removeCover()}
            />
        </section>
    );
}
