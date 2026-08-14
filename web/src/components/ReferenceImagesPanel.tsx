import { useEffect, useRef, useState } from 'react';
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
 *
 * **Fields belong to one picture at a time.** The note and the tags used to sit
 * loose at the bottom of the panel with no button under them, submitted as a
 * side effect of picking a file — so they read as the settings of the pictures
 * above, which have their own copy of the same fields. Choosing a file now
 * opens a draft card that carries those fields and ends in an explicit button.
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

    // The picture waiting to be described. Nothing is uploaded until the button
    // below it is pressed, so the note being typed is the note that is sent.
    const [draft, setDraft] = useState<{ file: File; previewUrl: string } | null>(null);
    const [label, setLabel] = useState('');
    const [roles, setRoles] = useState<ReferenceRole[]>(
        scope === 'campaign' ? ['style'] : ['clothing', 'armor_equipment'],
    );
    const [instruction, setInstruction] = useState('');
    const [autoSelect, setAutoSelect] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);

    useEffect(() => () => { if (draft) URL.revokeObjectURL(draft.previewUrl); }, [draft]);

    function chooseFile(file: File | null) {
        setError(null);
        setSaved(false);
        setDraft((current) => {
            if (current) URL.revokeObjectURL(current.previewUrl);
            return file ? { file, previewUrl: URL.createObjectURL(file) } : null;
        });
    }

    function discardDraft() {
        chooseFile(null);
        setLabel('');
        setInstruction('');
        if (fileInput.current) fileInput.current.value = '';
    }

    async function upload() {
        if (!draft) return;
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            await add(draft.file, label.trim() || null, roles, instruction.trim() || null, autoSelect);
            discardDraft();
            setSaved(true);
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
                                        setSaved(false);
                                        try {
                                            await update(reference.id, metadata);
                                            setSaved(true);
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
                <div className="reference-images__add">
                    <label className="reference-images__choose">
                        <span>{draft ? t.references.chooseAnother : t.references.chooseImage}</span>
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            disabled={busy}
                            onChange={(event) => chooseFile(event.currentTarget.files?.[0] ?? null)}
                        />
                    </label>

                    {draft && (
                        <div className="reference-images__draft">
                            <h3>{t.references.newReference}</h3>
                            <img src={draft.previewUrl} alt="" />
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
                            <div className="reference-images__draft-actions">
                                <button type="button" disabled={busy} onClick={() => void upload()}>
                                    {busy ? t.references.adding : t.references.add}
                                </button>
                                <button
                                    type="button"
                                    className="text-button"
                                    disabled={busy}
                                    onClick={discardDraft}
                                >
                                    {t.references.cancel}
                                </button>
                            </div>
                        </div>
                    )}

                    <p className="settings-hint">{t.media.rightsHint}</p>
                </div>
            )}

            <FormFeedback error={error} saved={saved} savedLabel={t.references.defaultsSaved} />

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
    onSave: (metadata: Pick<ReferenceImage, 'label' | 'roles' | 'instruction' | 'auto_select'>) => Promise<boolean>;
    onRemove: () => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [label, setLabel] = useState(reference.label ?? '');
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
                    {/* The note is the only way to tell six pictures apart in a
                        list, so it is correctable here and not only at upload. */}
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
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onSave({
                            label: label.trim() || null,
                            roles,
                            instruction: instruction.trim() || null,
                            auto_select: autoSelect,
                        }).then((stored) => { if (stored) setOpen(false); })}
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
