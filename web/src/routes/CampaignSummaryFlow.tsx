import { useState } from 'react';
import { useCampaignFlowActions } from '../api/hooks';
import { useT } from '../i18n';
import { FormFeedback } from '../components/FormFeedback';

/**
 * Which pipeline the Bardo writes this campaign's chronicle with.
 *
 * It lives in the **campaign** settings rather than the guild's because two
 * tables on the same server may want different things, and usually do: a long
 * campaign with a populated world gains from the agentic flow, a one-shot does
 * not.
 *
 * The cost difference has to be stated here, before the choice, and not
 * discovered in the end-of-session recap: it is the user's money on their own
 * provider account.
 */
export function CampaignSummaryFlow({
    campaignId, agentic, readOnly,
}: {
    campaignId: string;
    agentic: boolean;
    readOnly: boolean;
}) {
    const t = useT();
    const actions = useCampaignFlowActions(campaignId);
    const [choice, setChoice] = useState(agentic);
    const [saved, setSaved] = useState(false);

    const disabled = readOnly || actions.busy;

    return (
        <section className="settings-section">
            <h2>{t.summaryFlow.title}</h2>
            <p className="settings-hint">{t.summaryFlow.intro}</p>

            <fieldset className="ai-tier">
                <legend>{t.summaryFlow.title}</legend>

                <label className="settings-form__check">
                    <input
                        type="radio"
                        name="summary-flow"
                        checked={!choice}
                        disabled={disabled}
                        onChange={() => { setChoice(false); setSaved(false); }}
                    />
                    <span>
                        {t.summaryFlow.legacy}
                        <small>{t.summaryFlow.legacyHint}</small>
                    </span>
                </label>

                <label className="settings-form__check">
                    <input
                        type="radio"
                        name="summary-flow"
                        checked={choice}
                        disabled={disabled}
                        onChange={() => { setChoice(true); setSaved(false); }}
                    />
                    <span>
                        {t.summaryFlow.agentic}
                        <small>{t.summaryFlow.agenticHint}</small>
                    </span>
                </label>
            </fieldset>

            {/* Always visible, not only when the agentic path is
                chosen: the comparison is needed before the
                decision, not after it. */}
            <p className="settings-hint">{t.summaryFlow.costWarning}</p>

            <FormFeedback error={actions.error} saved={saved} savedLabel={t.summaryFlow.saved} />

            <button
                type="button"
                disabled={disabled}
                onClick={async () => {
                    const result = await actions.save(choice);
                    if (result) setSaved(true);
                }}
            >
                {t.summaryFlow.save}
            </button>
        </section>
    );
}
