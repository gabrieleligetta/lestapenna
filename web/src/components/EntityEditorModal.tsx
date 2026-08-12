import { useEffect, useState, type FormEvent } from 'react';
import { useEntityMutations } from '../api/hooks';
import type { CrudEntityType, EntityRow } from '../api/types';
import { useT } from '../i18n';
import type { Messages } from '../i18n/messages';
import {
    ENTITY_FORM_FIELDS,
    firstFormError,
    toFormValues,
    toMutationBody,
    type FormFieldSpec,
    type FormValues,
} from '../routes/entityFormConfig';
import { AiCostIndicator } from './AiCostIndicator';
import { Modal } from './Modal';
import { statusLabel } from './statusPresentation';

/**
 * The families whose RAG sync regenerates the description with AI.
 *
 * Saving calls nothing right now — the CRUD only touches SQLite — but it marks
 * the row `rag_sync_needed`, and at the next session's sync
 * `bard/sync/<family>.ts` invokes `generateBio` with the configured model:
 * a real provider cost, only deferred and batched.
 *
 * Outside the list for different reasons: NPCs because
 * `syncNpcDossierIfNeeded` uses the `manual_description` as it stands and skips
 * the call; inventory because its sync does not invoke AI at all; the timeline
 * because it ingests the event's text without rewriting it.
 *
 * No confirmation modal with an upfront estimate, unlike the quest audit: the
 * cost is not attributable to this single save (the entity may already have
 * been marked) and the prompt depends on the history at sync time, so an
 * estimate here would be made up.
 */
const REGENERATES_WITH_AI: ReadonlySet<CrudEntityType> = new Set<CrudEntityType>([
    'locations',
    'factions',
    'quests',
    'artifacts',
    'bestiary',
]);

/** The enum options are API keys: here we look up the translation that exists. */
function optionLabel(t: Messages, fieldKey: string, value: string): string {
    if (fieldKey === 'category') return t.inventory.categories[value as keyof typeof t.inventory.categories] ?? value;
    if (fieldKey === 'event_type') return t.timeline.types[value as keyof typeof t.timeline.types] ?? value;
    if (fieldKey === 'type' && (value === 'MAJOR' || value === 'MINOR')) return t.quests.types[value];
    // Faction status and type share the status vocabulary, which already has
    // its own localized map with a fallback to the raw value.
    return statusLabel(t, value);
}

function Field({
    field,
    value,
    disabled,
    onChange,
}: {
    field: FormFieldSpec;
    value: string;
    disabled: boolean;
    onChange: (value: string) => void;
}) {
    const t = useT();
    const label = t.fields[field.labelKey];

    if (field.type === 'bool') {
        return (
            <label className="entity-editor__checkbox">
                <input
                    type="checkbox"
                    checked={value === 'true'}
                    disabled={disabled}
                    onChange={(event) => onChange(event.currentTarget.checked ? 'true' : 'false')}
                />
                <span>{label}</span>
            </label>
        );
    }

    return (
        <label>
            <span>
                {label}
                {field.required && <span aria-hidden="true"> *</span>}
            </span>
            {field.type === 'longtext' ? (
                <textarea
                    rows={field.rows ?? 5}
                    maxLength={field.maxLength ?? 12000}
                    value={value}
                    disabled={disabled}
                    required={field.required}
                    onChange={(event) => onChange(event.currentTarget.value)}
                />
            ) : field.type === 'enum' ? (
                <select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
                    {(field.values ?? []).map((option) => (
                        <option key={option} value={option}>{optionLabel(t, field.key, option)}</option>
                    ))}
                </select>
            ) : field.type === 'int' ? (
                <input
                    type="number"
                    inputMode="numeric"
                    min={field.min}
                    max={field.max}
                    value={value}
                    disabled={disabled}
                    onChange={(event) => onChange(event.currentTarget.value)}
                />
            ) : (
                <input
                    type="text"
                    maxLength={field.maxLength ?? 200}
                    value={value}
                    disabled={disabled}
                    required={field.required}
                    onChange={(event) => onChange(event.currentTarget.value)}
                />
            )}
            {field.type === 'stringList' && <small className="field-hint">{t.crud.listHint}</small>}
        </label>
    );
}

/**
 * Editor for any campaign entity, create or edit.
 *
 * The form is generated from the schema in `entityFormConfig.ts`, which mirrors
 * the backend registry: adding a field to a family is one line in two files,
 * not a new component. `QuestEditorModal` was the hand-written version of this,
 * for a single family.
 */
export function EntityEditorModal({
    open,
    onClose,
    campaignId,
    entityType,
    entityLabel,
    row,
}: {
    open: boolean;
    /** `saved` is true when the modal closes after a successful save. */
    onClose: (saved?: boolean) => void;
    campaignId: string;
    entityType: CrudEntityType;
    /** Localized name of the family, for the modal's title. */
    entityLabel: string;
    /** The row to edit; absent for a creation. */
    row?: EntityRow | null;
}) {
    const t = useT();
    const fields = ENTITY_FORM_FIELDS[entityType];
    const { createEntity, updateEntity, busy, error, setError } = useEntityMutations(campaignId, entityType);
    const [values, setValues] = useState<FormValues>({});
    const [localError, setLocalError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setValues(toFormValues(fields, row));
        setLocalError(null);
        setError(null);
    }, [open, row, fields, setError]);

    const shortId = typeof row?.short_id === 'string' ? row.short_id : null;
    const title = row ? t.crud.editTitle(entityLabel) : t.crud.createTitle(entityLabel);

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (busy) return;

        const invalid = firstFormError(fields, values, t);
        if (invalid) {
            setLocalError(invalid);
            return;
        }
        setLocalError(null);

        const body = toMutationBody(fields, values);
        const saved = shortId ? await updateEntity(shortId, body) : await createEntity(body);
        if (saved) onClose(true);
    }

    return (
        <Modal open={open} onClose={() => !busy && onClose(false)} title={title}>
            <form className="entity-editor" onSubmit={(event) => void submit(event)}>
                <h2>{title}</h2>
                {fields.map((field) => (
                    <Field
                        key={field.key}
                        field={field}
                        value={values[field.key] ?? ''}
                        disabled={busy}
                        onChange={(next) => setValues((current) => ({ ...current, [field.key]: next }))}
                    />
                ))}
                {(localError || error) && <p role="alert" className="form-error">{localError ?? error}</p>}
                <div className="modal-actions">
                    <button type="button" onClick={() => onClose(false)} disabled={busy}>
                        {t.crud.cancel}
                    </button>
                    {REGENERATES_WITH_AI.has(entityType) && (
                        <AiCostIndicator
                            label={t.aiCost.deferredRegenLabel}
                            description={t.aiCost.deferredRegenDescription}
                        />
                    )}
                    <button type="submit" disabled={busy}>
                        {busy ? t.crud.saving : t.crud.save}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
