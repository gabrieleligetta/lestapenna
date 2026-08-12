import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAcceptLegal, useLegalStatus } from '../api/hooks';
import { useT } from '../i18n';
import { FormFeedback } from '../components/FormFeedback';

/**
 * Acceptance of the legal documents, before entering.
 *
 * Two **separate** checkboxes, and this is not legal pedantry:
 *
 *  - the **terms** are a contract and are accepted;
 *  - the **privacy notice** is not. Under GDPR it is an information duty, not a
 *    contract: «I accept the privacy notice» confuses transparency with
 *    consent — which here is not even the legal basis used — and it is a
 *    practice the authorities consider unfair. We record an acknowledgement.
 *
 * It blocks **the web app only**. The Discord commands keep working: the bot is
 * already on the server, and switching it off mid-evening for a bureaucratic
 * reason would give a marginal legal gain against real damage to use.
 *
 * ⚠️ This collects the acceptance of **whoever logs in**, who is not whoever
 * gets recorded. The safeguard for the players at the table is on Discord — the
 * nickname marked `[REC]` and the notice in the channel — because that is where
 * those people are.
 */
export function LegalGate() {
    const t = useT();
    const status = useLegalStatus();
    const actions = useAcceptLegal();

    const [terms, setTerms] = useState(false);
    const [privacy, setPrivacy] = useState(false);

    // Pending, or already settled: we let them through. A network error must not
    // lock out someone who has already accepted.
    if (!status.data || !status.data.needs_acceptance) return <Outlet />;

    const isUpdate = status.data.documents.some(
        (doc) => doc.accepted_version !== null && doc.needs_acceptance,
    );

    return (
        <div className="legal-gate">
            <div className="legal-gate__panel">
                <h1>{t.legal.title}</h1>
                <p>{t.legal.intro}</p>

                {/* Someone who had already accepted deserves to know that
                    something changed, rather than meeting the same modal with no
                    explanation. */}
                {isUpdate && <p className="status" role="status">{t.legal.updated}</p>}

                <p className="settings-hint">{t.legal.recordingWarning}</p>

                <label className="settings-form__check">
                    <input
                        type="checkbox"
                        checked={terms}
                        onChange={(event) => setTerms(event.target.checked)}
                    />
                    <span>
                        {t.legal.acceptTerms}
                        <small>
                            <a href="/terms" target="_blank" rel="noreferrer">{t.legal.readTerms}</a>
                        </small>
                    </span>
                </label>

                <label className="settings-form__check">
                    <input
                        type="checkbox"
                        checked={privacy}
                        onChange={(event) => setPrivacy(event.target.checked)}
                    />
                    <span>
                        {t.legal.acknowledgePrivacy}
                        <small>
                            <a href="/privacy" target="_blank" rel="noreferrer">{t.legal.readPrivacy}</a>
                        </small>
                    </span>
                </label>

                <FormFeedback error={actions.error} />

                <button
                    type="button"
                    className="primary"
                    disabled={!terms || !privacy || actions.busy}
                    onClick={() => actions.accept(['terms', 'privacy'])}
                >
                    {t.legal.continueLabel}
                </button>
            </div>
        </div>
    );
}
