import { useRef, useState } from 'react';
import { useReferenceImages } from '../api/hooks';
import type { ReferenceScope } from '../api/types';
import { useT } from '../i18n';
import { ConfirmModal } from './ConfirmModal';
import { Empty } from './StateViews';
import { FormFeedback } from './FormFeedback';

/**
 * The pictures the image model is told to draw from.
 *
 * Words pin a look down badly: «steel cuirass over a long gown» is satisfied by
 * a hundred different drawings. A picture is not. Two scopes reach this panel —
 * the campaign's art direction, which travels with everything the table
 * generates, and a faction's livery, which travels when one of its members is
 * drawn. They are the same component because they are the same idea at two
 * distances, and the only difference worth showing is the sentence explaining
 * when each one is used.
 */
export function ReferenceImagesPanel({
    campaignId,
    scope,
    scopeKey = '',
    canEdit,
}: {
    campaignId: string;
    scope: Extract<ReferenceScope, 'campaign' | 'faction'>;
    scopeKey?: string;
    canEdit: boolean;
}) {
    const t = useT();
    const { data: references, isLoading, add, remove } = useReferenceImages(campaignId, scope, scopeKey);
    const fileInput = useRef<HTMLInputElement>(null);

    const [label, setLabel] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);

    async function upload(file: File) {
        setBusy(true);
        setError(null);
        try {
            await add(file, label.trim() || null);
            setLabel('');
            if (fileInput.current) fileInput.current.value = '';
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        } finally {
            setBusy(false);
        }
    }

    async function confirmRemove() {
        if (!removing) return;
        const id = removing;
        setRemoving(null);
        setError(null);
        try {
            await remove(id);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        }
    }

    return (
        <section className="settings-section reference-images" aria-label={t.references.title}>
            <h2>{t.references.title}</h2>
            <p className="settings-hint">
                {scope === 'campaign' ? t.references.campaignHint : t.references.factionHint}
            </p>

            {isLoading ? null : references && references.length > 0 ? (
                <ul className="reference-images__list">
                    {references.map((reference) => (
                        <li key={reference.id} className="reference-images__item">
                            <img
                                src={reference.imageUrl}
                                alt={reference.label ?? t.references.title}
                                loading="lazy"
                            />
                            {reference.label && <span className="card-meta">{reference.label}</span>}
                            {canEdit && (
                                <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => setRemoving(reference.id)}
                                >
                                    {t.references.remove}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <Empty message={t.references.empty} />
            )}

            {canEdit && (
                <>
                    <label>
                        <span>{t.references.label}</span>
                        <input
                            type="text"
                            value={label}
                            maxLength={120}
                            disabled={busy}
                            placeholder={t.references.labelPlaceholder}
                            onChange={(event) => setLabel(event.currentTarget.value)}
                        />
                    </label>
                    <label>
                        <span>{busy ? t.references.adding : t.references.add}</span>
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            disabled={busy}
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (file) void upload(file);
                            }}
                        />
                    </label>
                    <p className="settings-hint">{t.media.rightsHint}</p>
                </>
            )}

            <FormFeedback error={error} saved={false} savedLabel="" />

            <ConfirmModal
                open={removing !== null}
                title={t.references.remove}
                question={t.references.confirmRemove}
                busy={false}
                confirmLabel={t.references.remove}
                busyLabel={t.references.adding}
                onClose={() => setRemoving(null)}
                onConfirm={() => void confirmRemove()}
            />
        </section>
    );
}
