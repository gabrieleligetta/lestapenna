import { useEffect, useState } from 'react';
import { useCharacterActions, useCharacterSheet, useMe } from '../api/hooks';
import type { BioRegenEstimate } from '../api/types';
import { useT } from '../i18n';
import { AiCostConfirmationModal, type AiCostConfirmation } from './AiCostConfirmationModal';
import { AiCostIndicator } from './AiCostIndicator';
import { Badge } from './Badge';
import { Empty } from './StateViews';
import { FormFeedback } from './FormFeedback';

/**
 * One's own character sheet, writable.
 *
 * The web counterpart of `$iam` and `$bio`: filling it in is also the gesture of
 * sitting down at the table, so it does not require already being a member.
 *
 * Regenerating the biography is the only costly action here, and it is single
 * and deliberate: the confirmation modal with the estimate is the right pattern
 * — unlike the chat, where the price sits in a fixed line.
 */
export function MyCharacterPanel({ campaignId }: { campaignId: string }) {
    const t = useT();
    const { data: me } = useMe();
    const sheet = useCharacterSheet(campaignId, me?.id ?? null);
    const actions = useCharacterActions(campaignId);

    const [name, setName] = useState('');
    const [race, setRace] = useState('');
    const [characterClass, setCharacterClass] = useState('');
    const [description, setDescription] = useState('');
    const [saved, setSaved] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [confirmation, setConfirmation] = useState<AiCostConfirmation | null>(null);

    useEffect(() => {
        if (!sheet.data) return;
        setName(sheet.data.character_name ?? '');
        setRace(sheet.data.race ?? '');
        setCharacterClass(sheet.data.class ?? '');
        setDescription(sheet.data.description ?? '');
    }, [sheet.data]);

    if (!me) return null;

    const exists = Boolean(sheet.data);

    async function save(event: React.FormEvent) {
        event.preventDefault();
        setSaved(false);
        setNotice(null);
        const result = await actions.saveOwnSheet({
            character_name: name.trim(),
            ...(race.trim() ? { race: race.trim() } : {}),
            ...(characterClass.trim() ? { class: characterClass.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
        });
        if (result) {
            setSaved(true);
            await sheet.refetch();
        }
    }

    /** Free preview: the model is not invoked until the user confirms. */
    async function previewBio() {
        setNotice(null);
        let estimate: BioRegenEstimate;
        try {
            estimate = await actions.estimateBio(me!.id);
        } catch {
            actions.setError(t.aiCost.loadingEstimate);
            return;
        }

        // With no history there is nothing to rebuild: say so, rather than opening
        // a spend confirmation for an action that spends nothing and does nothing.
        if (!estimate.will_invoke_ai) {
            setNotice(t.characterSheet.noHistory);
            return;
        }

        setConfirmation({
            action: t.characterSheet.regenerate,
            scope: name.trim() || (sheet.data?.character_name ?? ''),
            provider: estimate.provider,
            model: estimate.model,
            tokens: null,
            // The monetary estimate for the bio will come from the cost layer: until
            // it does, the modal honestly declares "price unknown" instead of
            // inventing a number.
            billable: true,
            estimatedCostEur: null,
            estimatedCostUsd: null,
        });
    }

    return (
        <section className="my-character">
            <div className="page-heading">
                <h2>{t.characterSheet.title}</h2>
                {sheet.data?.is_manual && <Badge tone="neutral">{t.characterSheet.manualBadge}</Badge>}
            </div>

            {!exists && <Empty message={t.characterSheet.none} />}

            <form className="settings-form" onSubmit={save}>
                <label>
                    <span>{t.characterSheet.name}</span>
                    <input
                        value={name}
                        maxLength={80}
                        required
                        disabled={actions.busy}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>

                <label>
                    <span>{t.characterSheet.race}</span>
                    <input
                        value={race}
                        maxLength={80}
                        disabled={actions.busy}
                        onChange={(event) => setRace(event.target.value)}
                    />
                </label>

                <label>
                    <span>{t.characterSheet.class}</span>
                    <input
                        value={characterClass}
                        maxLength={80}
                        disabled={actions.busy}
                        onChange={(event) => setCharacterClass(event.target.value)}
                    />
                </label>

                <label>
                    <span>{t.characterSheet.biography}</span>
                    <textarea
                        value={description}
                        maxLength={4000}
                        rows={6}
                        disabled={actions.busy}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                    <small>{t.characterSheet.biographyHint}</small>
                </label>

                <FormFeedback error={actions.error} />
                {notice && <p className="status" role="status">{notice}</p>}
                <FormFeedback saved={saved} savedLabel={t.campaignAdmin.saved} />

                <div className="modal-actions">
                    <button type="submit" className="primary" disabled={actions.busy || name.trim().length === 0}>
                        {exists ? t.characterSheet.save : t.characterSheet.create}
                    </button>
                    {exists && (
                        <span className="my-character__regen">
                            <AiCostIndicator
                                label={t.aiCost.indicatorLabel}
                                description={t.aiCost.indicatorDescription}
                            />
                            <button type="button" onClick={() => void previewBio()} disabled={actions.busy}>
                                {t.characterSheet.regenerate}
                            </button>
                        </span>
                    )}
                </div>
                {exists && <small className="my-character__hint">{t.characterSheet.regenerateHint}</small>}
            </form>

            <AiCostConfirmationModal
                open={confirmation !== null}
                estimate={confirmation}
                busy={actions.busy}
                onClose={() => setConfirmation(null)}
                onConfirm={async () => {
                    const result = await actions.regenerateBio(me!.id);
                    setConfirmation(null);
                    if (result) {
                        setNotice(t.characterSheet.regenerated);
                        await sheet.refetch();
                    }
                }}
            />
        </section>
    );
}
