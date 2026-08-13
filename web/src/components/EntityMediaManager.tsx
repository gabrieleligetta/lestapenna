import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import type { EntityImage, MediaEntityType, ReferenceRole } from '../api/types';
import { useEntityImages } from '../api/hooks';
import { useT } from '../i18n';
import { ConfirmModal } from './ConfirmModal';
import { EntityImageGenerator } from './EntityImageGenerator';
import { Icon } from './icons';
import { ReferenceMetadataFields } from './ReferenceMetadataFields';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function EntityMediaManager({
    campaignId,
    entityType,
    entityId,
    image,
    canEdit,
}: {
    campaignId: string;
    entityType: MediaEntityType;
    entityId: string;
    image?: EntityImage | null;
    canEdit: boolean;
}) {
    const t = useT();
    const queryClient = useQueryClient();
    const { data: gallery, refetch: refetchGallery } = useEntityImages(campaignId, entityType, entityId);
    const [removingOne, setRemovingOne] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const summaryRef = useRef<HTMLElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [altText, setAltText] = useState(image?.altText ?? '');
    const [focalX, setFocalX] = useState(image?.focalX ?? 50);
    const [focalY, setFocalY] = useState(image?.focalY ?? 50);
    const [busy, setBusy] = useState<'upload' | 'metadata' | 'remove' | null>(null);
    const [confirmingRemove, setConfirmingRemove] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setAltText(image?.altText ?? '');
        setFocalX(image?.focalX ?? 50);
        setFocalY(image?.focalY ?? 50);
        setConfirmingRemove(false);
    }, [image?.id, image?.altText, image?.focalX, image?.focalY]);

    if (!canEdit) return null;

    const imagePath = `/campaigns/${campaignId}/${entityType}/${encodeURIComponent(entityId)}/image`;

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] });
        await refetchGallery();
    }

    /** Which picture the sheet shows — a decision, not a side effect of being newest. */
    async function makePrimary(mediaId: string) {
        setError(null);
        try {
            await apiFetch(`/campaigns/${campaignId}/media/${encodeURIComponent(mediaId)}/primary`, {
                method: 'POST',
            });
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        }
    }

    async function removeOne(mediaId: string) {
        setRemovingOne(null);
        setError(null);
        try {
            await apiFetch<void>(`/campaigns/${campaignId}/media/${encodeURIComponent(mediaId)}`, {
                method: 'DELETE',
            });
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        }
    }

    function chooseFile(nextFile: File | null) {
        setMessage(null);
        setError(null);
        if (!nextFile) {
            setFile(null);
            return;
        }
        if (!ACCEPTED_TYPES.has(nextFile.type)) {
            setFile(null);
            setError(t.media.invalidFile);
            if (fileRef.current) fileRef.current.value = '';
            return;
        }
        if (nextFile.size > MAX_FILE_BYTES) {
            setFile(null);
            setError(t.media.tooLarge);
            if (fileRef.current) fileRef.current.value = '';
            return;
        }
        setFile(nextFile);
    }

    function dropFile(event: DragEvent<HTMLLabelElement>) {
        event.preventDefault();
        chooseFile(event.dataTransfer.files?.[0] ?? null);
    }

    async function upload(event: FormEvent) {
        event.preventDefault();
        if (!file || busy) return;
        setBusy('upload');
        setMessage(null);
        setError(null);
        const form = new FormData();
        form.append('file', file);
        if (altText.trim()) form.append('altText', altText.trim());

        try {
            await apiFetch<EntityImage>(imagePath, { method: 'PUT', body: form });
            setFile(null);
            if (fileRef.current) fileRef.current.value = '';
            await refresh();
            setMessage(t.media.updated);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        } finally {
            setBusy(null);
        }
    }

    async function saveMetadata(event: FormEvent) {
        event.preventDefault();
        if (!image || busy) return;
        setBusy('metadata');
        setMessage(null);
        setError(null);

        try {
            await apiFetch<EntityImage>(`/campaigns/${campaignId}/media/${image.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    altText: altText.trim() || null,
                    focalX,
                    focalY,
                }),
            });
            await refresh();
            setMessage(t.media.updated);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        } finally {
            setBusy(null);
        }
    }

    async function remove() {
        if (!image || busy) return;
        setBusy('remove');
        setMessage(null);
        setError(null);

        try {
            await apiFetch<void>(imagePath, { method: 'DELETE' });
            await refresh();
            setConfirmingRemove(false);
            setMessage(t.media.updated);
            window.requestAnimationFrame(() => summaryRef.current?.focus());
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="entity-media-manager" aria-label={t.media.image}>
            <details>
                <summary ref={summaryRef}>
                    <Icon name="edit" />
                    {t.media.image}
                </summary>
                <div className="entity-media-manager__body">
                    {gallery && gallery.length > 0 && (
                        <section className="entity-media-manager__gallery" aria-label={t.media.gallery}>
                            <h3>{t.media.gallery}</h3>
                            <p className="settings-hint">{t.media.galleryHint}</p>
                            <ul>
                                {gallery.map((picture) => (
                                    <li key={picture.id}>
                                        <img src={picture.thumbnailUrl} alt={picture.altText ?? ''} loading="lazy" />
                                        {picture.isPrimary ? (
                                            <span className="card-meta">{t.media.primary}</span>
                                        ) : (
                                            <button
                                                type="button"
                                                className="text-button"
                                                onClick={() => void makePrimary(picture.id)}
                                            >
                                                {t.media.makePrimary}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className="text-button text-button--danger"
                                            onClick={() => setRemovingOne(picture.id)}
                                        >
                                            {t.media.removeOne}
                                        </button>
                                        <GalleryReferenceEditor
                                            campaignId={campaignId}
                                            picture={picture}
                                            onSaved={refresh}
                                        />
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    <form className="entity-media-manager__upload" onSubmit={(event) => void upload(event)}>
                <label
                    className="entity-media-manager__dropzone"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={dropFile}
                >
                    <span>{t.media.upload}</span>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(event) => chooseFile(event.currentTarget.files?.[0] ?? null)}
                    />
                </label>
                <small>{t.media.uploadHint}</small>
                <p className="settings-hint">{t.media.rightsHint}</p>
                <button type="submit" disabled={!file || busy !== null}>
                    <Icon name="edit" />
                    {t.media.upload}
                </button>
                    </form>

                    {image && (
                        <form className="entity-media-manager__metadata" onSubmit={(event) => void saveMetadata(event)}>
                    <label>
                        <span>{t.media.altText}</span>
                        <input
                            type="text"
                            value={altText}
                            maxLength={300}
                            onChange={(event) => setAltText(event.currentTarget.value)}
                        />
                    </label>
                    <label>
                        <span>{t.media.focalX}: {focalX}%</span>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={focalX}
                            onChange={(event) => setFocalX(Number(event.currentTarget.value))}
                        />
                    </label>
                    <label>
                        <span>{t.media.focalY}: {focalY}%</span>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={focalY}
                            onChange={(event) => setFocalY(Number(event.currentTarget.value))}
                        />
                    </label>
                    <button type="submit" disabled={busy !== null}>
                        {t.media.saveDetails}
                    </button>
                        </form>
                    )}

                    {image && (
                        <div className="entity-media-manager__remove">
                            <button
                                type="button"
                                className="text-button text-button--danger"
                                onClick={() => setConfirmingRemove(true)}
                            >
                                {t.media.remove}
                            </button>
                        </div>
                    )}

                    <EntityImageGenerator
                        campaignId={campaignId}
                        entityType={entityType}
                        entityId={entityId}
                        image={image}
                        onGenerated={refresh}
                    />

                    <div className="entity-media-manager__feedback" aria-live="polite">
                        {busy && <span>{t.common.loading}</span>}
                        {message && <span>{message}</span>}
                        {error && <span role="alert">{error}</span>}
                    </div>
                </div>
            </details>

            <ConfirmModal
                open={removingOne !== null}
                title={t.media.removeOne}
                question={t.media.confirmRemoveOne}
                busy={false}
                confirmLabel={t.media.removeOne}
                busyLabel={t.common.loading}
                onConfirm={() => void removeOne(removingOne!)}
                onClose={() => setRemovingOne(null)}
            />

            <ConfirmModal
                open={confirmingRemove}
                title={t.media.remove}
                question={t.media.confirmRemove}
                busy={busy === 'remove'}
                error={error}
                confirmLabel={t.media.remove}
                busyLabel={t.common.loading}
                onConfirm={() => void remove()}
                onClose={() => {
                    setConfirmingRemove(false);
                    window.requestAnimationFrame(() => summaryRef.current?.focus());
                }}
            />
        </section>
    );
}

function GalleryReferenceEditor({
    campaignId,
    picture,
    onSaved,
}: {
    campaignId: string;
    picture: EntityImage;
    onSaved: () => Promise<void>;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [roles, setRoles] = useState<ReferenceRole[]>(picture.referenceRoles ?? ['subject_identity']);
    const [instruction, setInstruction] = useState(picture.referenceInstruction ?? '');
    const [autoSelect, setAutoSelect] = useState(picture.referenceAutoSelect ?? false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setRoles(picture.referenceRoles ?? ['subject_identity']);
        setInstruction(picture.referenceInstruction ?? '');
        setAutoSelect(picture.referenceAutoSelect ?? false);
    }, [picture.id, picture.referenceRoles, picture.referenceInstruction, picture.referenceAutoSelect]);

    async function save() {
        setSaving(true);
        setError(null);
        try {
            await apiFetch(`/campaigns/${campaignId}/media/${encodeURIComponent(picture.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    referenceRoles: roles,
                    referenceInstruction: instruction.trim() || null,
                    referenceAutoSelect: autoSelect,
                }),
            });
            await onSaved();
            setOpen(false);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t.common.error);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="entity-media-manager__reference-editor">
            <button type="button" className="text-button" onClick={() => setOpen((value) => !value)}>
                {t.references.editDefaults}
            </button>
            {open && (
                <>
                    <ReferenceMetadataFields
                        roles={roles}
                        instruction={instruction}
                        autoSelect={autoSelect}
                        disabled={saving}
                        // The main portrait is a contextual default. It remains
                        // visible and deselectable in each generation; this
                        // persistent toggle applies to the rest of the gallery.
                        showAutoSelect={!picture.isPrimary}
                        onRolesChange={setRoles}
                        onInstructionChange={setInstruction}
                        onAutoSelectChange={setAutoSelect}
                    />
                    <button type="button" disabled={saving} onClick={() => void save()}>
                        {t.references.saveDefaults}
                    </button>
                    {error && <span className="form-error" role="alert">{error}</span>}
                </>
            )}
        </div>
    );
}
