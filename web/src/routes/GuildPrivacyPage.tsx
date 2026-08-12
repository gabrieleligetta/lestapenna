import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api/client';
import { useT } from '../i18n';
import { ConfirmModal } from '../components/ConfirmModal';

/**
 * Your data, on this server: get a copy, or erase it.
 *
 * The web counterpart of `$mydata` and `$forgetme`, calling the very same
 * services — a right that only exists in one of the two interfaces is a right
 * half the people at a table never find.
 *
 * Both routes live under `/api/v1/me`, which the legal gate exempts. That is
 * deliberate: someone who has *refused* the terms must still be able to take
 * their data and leave.
 */
export function GuildPrivacyPage() {
    const { guildId = '' } = useParams();
    const t = useT();

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [erased, setErased] = useState<{ rows: number; files: number; complete: boolean } | null>(null);

    async function download() {
        setBusy(true);
        setError(null);
        try {
            const data = await apiFetch<unknown>(`/me/guilds/${guildId}/export`);
            // Built in the browser rather than served as an attachment: the
            // payload is the person's own transcripts, and a download URL is one
            // more place for them to leak.
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `lestapenna-${guildId}.json`;
            link.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function erase() {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<{ rows: number; files: number; complete: boolean }>(
                `/me/guilds/${guildId}/data`,
                { method: 'DELETE' },
            );
            setErased(result);
            setConfirming(false);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="settings-page">
            <h1>{t.privacy.title}</h1>
            <p className="settings-hint">{t.privacy.intro}</p>

            <div className="settings-section">
                <h2>{t.privacy.exportTitle}</h2>
                <p className="settings-hint">{t.privacy.exportBody}</p>
                <button type="button" disabled={busy} onClick={download}>
                    {t.privacy.exportButton}
                </button>
            </div>

            <div className="settings-section">
                <h2>{t.privacy.eraseTitle}</h2>
                <p className="settings-hint">{t.privacy.eraseBody}</p>
                {erased ? (
                    <p className={erased.complete ? 'status' : 'settings-hint settings-hint--warn'}>
                        {erased.complete
                            ? t.privacy.eraseDone(erased.rows, erased.files)
                            : t.privacy.erasePartial}
                    </p>
                ) : (
                    <button type="button" className="danger-button" disabled={busy} onClick={() => setConfirming(true)}>
                        {t.privacy.eraseButton}
                    </button>
                )}
            </div>

            <p className="settings-hint">
                <a href="/privacy" target="_blank" rel="noreferrer">{t.privacy.readPolicy}</a>
                {' · '}
                <a href="/terms" target="_blank" rel="noreferrer">{t.privacy.readTerms}</a>
            </p>

            {error && <p className="form-error" role="alert">{error}</p>}

            <ConfirmModal
                open={confirming}
                title={t.privacy.eraseTitle}
                question={t.privacy.eraseConfirmQuestion}
                consequences={<p>{t.privacy.eraseConfirmConsequences}</p>}
                busy={busy}
                error={error}
                confirmLabel={t.privacy.eraseButton}
                busyLabel={t.privacy.erasing}
                onConfirm={erase}
                onClose={() => setConfirming(false)}
            />
        </section>
    );
}
