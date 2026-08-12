import { useState } from 'react';
import { useCreateCampaign } from '../api/hooks';
import { LOCALES, useLocale, useT, type Locale } from '../i18n';
import { Modal } from './Modal';

const LANGUAGE_NAMES: Record<Locale, string> = {
    en: 'English',
    it: 'Italiano',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    'pt-BR': 'Português (Brasil)',
};

/**
 * Campaign creation from the site.
 *
 * On Discord it is three separate steps (`$creacampagna`, `$language`,
 * `$setworld`); from the web a single form is expected, with only the name
 * required. It consumes no credit: no provider is invoked.
 */
export function CreateCampaignModal({
    open,
    guildId,
    onClose,
    onCreated,
}: {
    open: boolean;
    guildId: string;
    onClose: () => void;
    onCreated: (campaignId: number) => void;
}) {
    const t = useT();
    const { locale } = useLocale();
    const { create, busy, error, setError } = useCreateCampaign(guildId);

    const [name, setName] = useState('');
    // The most likely spoken language is the one the site is being used in.
    const [language, setLanguage] = useState<string>(locale);
    const [year, setYear] = useState('');
    const [partyName, setPartyName] = useState('');

    function reset() {
        setName('');
        setLanguage(locale);
        setYear('');
        setPartyName('');
        setError(null);
    }

    return (
        <Modal
            open={open}
            onClose={() => {
                if (busy) return;
                reset();
                onClose();
            }}
            title={t.campaignAdmin.createTitle}
        >
            <form
                className="settings-form"
                onSubmit={async (event) => {
                    event.preventDefault();
                    const parsedYear = year.trim() === '' ? undefined : Number(year);
                    const created = await create({
                        name: name.trim(),
                        language,
                        ...(parsedYear !== undefined && Number.isFinite(parsedYear) ? { current_year: parsedYear } : {}),
                        ...(partyName.trim() ? { party_name: partyName.trim() } : {}),
                    });
                    if (created) {
                        reset();
                        onCreated(created.id);
                    }
                }}
            >
                <h2>{t.campaignAdmin.createTitle}</h2>
                <p className="status">{t.campaignAdmin.createIntro}</p>

                <label>
                    <span>{t.campaignAdmin.name}</span>
                    <input
                        value={name}
                        maxLength={80}
                        required
                        autoFocus
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>

                <label>
                    <span>{t.campaignAdmin.language}</span>
                    <select value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value)}>
                        {(Object.keys(LOCALES) as Locale[]).map((code) => (
                            <option key={code} value={code}>{LANGUAGE_NAMES[code]}</option>
                        ))}
                    </select>
                    <small>{t.campaignAdmin.languageHint}</small>
                </label>

                <label>
                    <span>{t.campaignAdmin.year}</span>
                    <input
                        type="number"
                        value={year}
                        disabled={busy}
                        onChange={(event) => setYear(event.target.value)}
                    />
                </label>

                <label>
                    <span>{t.campaignAdmin.partyName}</span>
                    <input
                        value={partyName}
                        maxLength={80}
                        disabled={busy}
                        onChange={(event) => setPartyName(event.target.value)}
                    />
                </label>

                {error && <p className="form-error" role="alert">{error}</p>}

                <div className="modal-actions">
                    <button type="button" onClick={onClose} disabled={busy}>
                        {t.crud.cancel}
                    </button>
                    <button type="submit" className="primary" disabled={busy || name.trim().length === 0}>
                        {busy ? t.common.loading : t.campaignAdmin.createSubmit}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
