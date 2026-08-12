import { useEffect, useState, type FormEvent } from 'react';
import { useEntityMutations } from '../api/hooks';
import type { CrudEntityType, EventMutation, HistoryEvent } from '../api/types';
import { useT } from '../i18n';
import { Modal } from './Modal';

/**
 * The `event_type` values offered in the dropdown.
 *
 * Mirrors MANUAL_EVENT_TYPES in the backend: the bot writes per-domain types
 * (REVELATION, LOOT, ENCOUNTER…) and a per-family dropdown would be eight lists
 * to keep aligned. The type already on the row is added, so correcting the
 * description of an AI-generated event does not change its type as a side
 * effect.
 */
const MANUAL_EVENT_TYPES = ['NOTE', 'MANUAL_UPDATE', 'GENERIC', 'OBSERVATION'] as const;

const WEIGHT_MIN = -10;
const WEIGHT_MAX = 10;

function clampWeight(raw: string): number {
    const value = Math.trunc(Number(raw) || 0);
    return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, value));
}

export function EventEditorModal({
    open,
    onClose,
    campaignId,
    entityType,
    entityId,
    event,
    /** True on NPCs, characters and factions: the only tables that weight alignment. */
    weighted,
}: {
    open: boolean;
    onClose: (saved?: boolean) => void;
    campaignId: string;
    entityType: CrudEntityType;
    entityId: string;
    event: HistoryEvent | null;
    weighted: boolean;
}) {
    const t = useT();
    const { updateEvent, busy, error, setError } = useEntityMutations(campaignId, entityType);
    const [description, setDescription] = useState('');
    const [eventType, setEventType] = useState('NOTE');
    const [moral, setMoral] = useState('0');
    const [ethical, setEthical] = useState('0');

    useEffect(() => {
        if (!open || !event) return;
        setDescription(event.description);
        setEventType(event.event_type || 'NOTE');
        setMoral(String(event.moral_weight ?? 0));
        setEthical(String(event.ethical_weight ?? 0));
        setError(null);
    }, [open, event, setError]);

    if (!event) return null;

    const types = [...new Set<string>([...MANUAL_EVENT_TYPES, event.event_type].filter(Boolean))];

    async function submit(formEvent: FormEvent) {
        formEvent.preventDefault();
        if (busy || !event || !description.trim()) return;

        const mutation: EventMutation = {
            description: description.trim(),
            event_type: eventType,
        };
        if (weighted) {
            mutation.moral_weight = clampWeight(moral);
            mutation.ethical_weight = clampWeight(ethical);
        }
        const saved = await updateEvent(entityId, event.id, mutation);
        if (saved !== null) onClose(true);
    }

    return (
        <Modal open={open} onClose={() => !busy && onClose(false)} title={t.events.edit}>
            <form className="entity-editor" onSubmit={(formEvent) => void submit(formEvent)}>
                <h2>{t.events.edit}</h2>
                <label>
                    <span>{t.fields.description}</span>
                    <textarea
                        rows={6}
                        maxLength={12000}
                        required
                        value={description}
                        disabled={busy}
                        onChange={(input) => setDescription(input.currentTarget.value)}
                    />
                </label>
                <label>
                    <span>{t.events.eventType}</span>
                    <select
                        value={eventType}
                        disabled={busy}
                        onChange={(input) => setEventType(input.currentTarget.value)}
                    >
                        {types.map((type) => (
                            <option key={type} value={type}>{type}</option>
                        ))}
                    </select>
                </label>

                {weighted && (
                    <>
                        <div className="entity-editor__row">
                            <label>
                                <span>{t.events.moralWeight}</span>
                                <input
                                    type="number"
                                    inputMode="numeric"
                                    min={WEIGHT_MIN}
                                    max={WEIGHT_MAX}
                                    value={moral}
                                    disabled={busy}
                                    onChange={(input) => setMoral(input.currentTarget.value)}
                                />
                            </label>
                            <label>
                                <span>{t.events.ethicalWeight}</span>
                                <input
                                    type="number"
                                    inputMode="numeric"
                                    min={WEIGHT_MIN}
                                    max={WEIGHT_MAX}
                                    value={ethical}
                                    disabled={busy}
                                    onChange={(input) => setEthical(input.currentTarget.value)}
                                />
                            </label>
                        </div>
                        <p className="field-hint">{t.events.weightHint}</p>
                    </>
                )}

                {error && <p role="alert" className="form-error">{error}</p>}
                <div className="modal-actions">
                    <button type="button" onClick={() => onClose(false)} disabled={busy}>
                        {t.crud.cancel}
                    </button>
                    <button type="submit" disabled={busy || !description.trim()}>
                        {busy ? t.crud.saving : t.crud.save}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
