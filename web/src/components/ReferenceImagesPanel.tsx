import { useRef, useState } from 'react';
import { useReferenceImages } from '../api/hooks';
import type { ReferenceImage, ReferenceRole, ReferenceScope } from '../api/types';
import { useT } from '../i18n';
import { ConfirmModal } from './ConfirmModal';
import { Empty } from './StateViews';
import { FormFeedback } from './FormFeedback';
import { ReferenceMetadataFields } from './ReferenceMetadataFields';

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
    const { data: references, isLoading, add, update, remove } = useReferenceImages(campaignId, scope, scopeKey);
    const fileInput = useRef<HTMLInputElement>(null);

    const [label, setLabel] = useState('');
    const [roles, setRoles] = useState<ReferenceRole[]>(
        scope === 'campaign' ? ['style'] : ['clothing', 'armor_equipment'],
    );
    const [instruction, setInstruction] = useState('');
    const [autoSelect, setAutoSelect] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);

    async function upload(file: File) {
        setBusy(true);
        setError(null);
        try {
            await add(file, label.trim() || null, roles, instruction.trim() || null, autoSelect);
            setLabel('');
            setInstruction('');
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
                                <SavedReferenceEditor
                                    reference={reference}
                                    busy={busy}
                                    onSave={async (metadata) => {
                                        setBusy(true);
                                        setError(null);
                                        try {
                                            await update(reference.id, metadata);
                                            return true;
                                        } catch (reason) {
                                            setError(reason instanceof Error ? reason.message : t.common.error);
                                            return false;
                                        } finally {
                                            setBusy(false);
                                        }
                                    }}
                                    onRemove={() => setRemoving(reference.id)}
                                />
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
                    <ReferenceMetadataFields
                        roles={roles}
                        instruction={instruction}
                        autoSelect={autoSelect}
                        disabled={busy}
                        showAutoSelect
                        onRolesChange={setRoles}
                        onInstructionChange={setInstruction}
                        onAutoSelectChange={setAutoSelect}
                    />
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

function SavedReferenceEditor({
    reference,
    busy,
    onSave,
    onRemove,
}: {
    reference: ReferenceImage;
    busy: boolean;
    onSave: (metadata: Pick<ReferenceImage, 'roles' | 'instruction' | 'auto_select'>) => Promise<boolean>;
    onRemove: () => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [roles, setRoles] = useState(reference.roles);
    const [instruction, setInstruction] = useState(reference.instruction ?? '');
    const [autoSelect, setAutoSelect] = useState(reference.auto_select);

    return (
        <div className="reference-images__editor">
            <button type="button" className="text-button" onClick={() => setOpen((value) => !value)}>
                {t.references.editDefaults}
            </button>
            {open && (
                <>
                    <ReferenceMetadataFields
                        roles={roles}
                        instruction={instruction}
                        autoSelect={autoSelect}
                        disabled={busy}
                        showAutoSelect
                        onRolesChange={setRoles}
                        onInstructionChange={setInstruction}
                        onAutoSelectChange={setAutoSelect}
                    />
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onSave({
                            roles,
                            instruction: instruction.trim() || null,
                            auto_select: autoSelect,
                        }).then((saved) => { if (saved) setOpen(false); })}
                    >
                        {t.references.saveDefaults}
                    </button>
                </>
            )}
            <button type="button" className="text-button" onClick={onRemove}>
                {t.references.remove}
            </button>
        </div>
    );
}
