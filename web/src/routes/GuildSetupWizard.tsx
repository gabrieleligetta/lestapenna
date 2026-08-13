import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
    useCreateCampaign,
    useGuildAiSettings,
    useGuildAiSettingsActions,
    useGuildCampaigns,
    useTranscriptionSettings,
} from '../api/hooks';
import type { AiCredentialTestResult, AiProvider, TierChoice } from '../api/types';
import { LOCALES, useLocale, useT, type Locale } from '../i18n';
import { ErrorState, Loading } from '../components/StateViews';
import { FormFeedback } from '../components/FormFeedback';
import { Stepper } from '../components/Stepper';
import { PROVIDER_CONSOLE, providerName } from '../components/aiLabels';
import { buildChecklist } from '../components/setupChecklistModel';
import { TierPicker } from './GuildAiSettingsPage';
import { TranscriptionSettings } from './TranscriptionSettings';

const LANGUAGE_NAMES: Record<Locale, string> = {
    en: 'English',
    it: 'Italiano',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    'pt-BR': 'Português (Brasil)',
};

/** Providers a table can pick at the first step. Ollama is the table's own hardware. */
const STARTING_POINTS: AiProvider[] = ['openai', 'gemini', 'ollama'];

/**
 * The guided first configuration of a server.
 *
 * A table cannot record without a key and a transcription engine — `$listen`
 * refuses, and rightly, because a session recorded without them is hours of
 * audio nobody can read. What was missing was any path to that state: a new
 * server showed an empty campaign list with two small links, and the settings
 * page opened on six sections and one red line.
 *
 * **Not a gate.** Every step writes as it goes, through the same endpoints the
 * settings page uses, so leaving halfway leaves a table half configured rather
 * than nothing — and coming back resumes where the data says it stopped. There
 * is also no review step: the secrets never come back from any GET, so a
 * «check your answers» screen could only lie about them.
 */
export function GuildSetupWizard() {
    const { guildId = '' } = useParams();
    const t = useT();
    const navigate = useNavigate();

    const settings = useGuildAiSettings(guildId);
    const transcription = useTranscriptionSettings(guildId);
    const campaigns = useGuildCampaigns(guildId);

    const [step, setStep] = useState(0);

    if (settings.isLoading) return <Loading />;
    if (settings.isError && !settings.data) return <ErrorState error={settings.error} />;
    if (!settings.data) return null;

    const data = settings.data;
    const readOnly = !data.can_manage;
    const steps = [
        t.setup.stepKey,
        t.setup.stepModels,
        t.setup.stepTranscription,
        t.setup.stepCampaign,
        t.setup.stepReady,
    ];

    const items = buildChecklist(t, data, transcription.data, campaigns.data?.length);
    const outstanding = items.filter((item) => item.state === 'missing').length;

    return (
        <div className="settings-page">
            <h1>{t.setup.title}</h1>
            <p className="settings-intro">{t.setup.intro}</p>

            {/* Reading the settings only requires being a member of the server;
                changing them does not. Someone who cannot act is told so once,
                instead of meeting a disabled control per step. */}
            {readOnly && <p className="form-error" role="status">{t.setup.readOnly}</p>}

            <Stepper steps={steps} current={step} label={t.setup.title} />

            {step === 0 && <KeyStep guildId={guildId} readOnly={readOnly} />}
            {step === 1 && (
                <ModelsStep guildId={guildId} readOnly={readOnly} />
            )}
            {step === 2 && (
                <section className="settings-section">
                    <h2>{t.setup.transcriptionTitle}</h2>
                    <p className="settings-hint">{t.setup.transcriptionIntro}</p>
                    <TranscriptionSettings guildId={guildId} readOnly={readOnly} credentials={data.credentials} />
                </section>
            )}
            {step === 3 && (
                <CampaignStep guildId={guildId} readOnly={readOnly} existing={campaigns.data?.[0]?.name} />
            )}
            {step === 4 && (
                <ReadyStep
                    guildId={guildId}
                    campaignId={campaigns.data?.[0]?.id}
                    outstanding={outstanding}
                />
            )}

            <div className="ai-credential__row">
                <button type="button" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>
                    {t.setup.back}
                </button>
                {step < steps.length - 1 ? (
                    <button type="button" className="primary" onClick={() => setStep((value) => value + 1)}>
                        {t.setup.next}
                    </button>
                ) : (
                    <button type="button" className="primary" onClick={() => navigate(`/guilds/${guildId}/ai`)}>
                        {t.setup.finish}
                    </button>
                )}
                <Link to={`/guilds/${guildId}/ai`}>{t.setup.exit}</Link>
            </div>
        </div>
    );
}

/**
 * Step one: where the AI runs, and the key that pays for it.
 *
 * Saving and verifying are one button here, unlike the settings page: someone
 * pasting a key for the first time has no way to tell a typo from a provider
 * being down, and the answer to both arrives from the same round trip.
 */
function KeyStep({ guildId, readOnly }: { guildId: string; readOnly: boolean }) {
    const t = useT();
    const settings = useGuildAiSettings(guildId);
    const actions = useGuildAiSettingsActions(guildId);

    const [provider, setProvider] = useState<AiProvider>('gemini');
    const [draft, setDraft] = useState('');
    const [result, setResult] = useState<AiCredentialTestResult | null>(null);

    const credential = settings.data?.credentials.find((entry) => entry.provider === provider);

    async function saveAndVerify() {
        setResult(null);
        const saved = await actions.saveKey(provider, draft.trim());
        if (saved === null) return;
        setDraft(''); // not kept in the page a moment longer than needed
        setResult(await actions.testKey(provider));
    }

    return (
        <section className="settings-section">
            <h2>{t.setup.keyTitle}</h2>
            <p className="settings-hint">{t.setup.keyIntro}</p>

            <fieldset className="ai-tier">
                <legend>{t.aiSettings.provider}</legend>
                {STARTING_POINTS.map((candidate) => (
                    <label key={candidate} className="settings-form__check">
                        <input
                            type="radio"
                            name="setup-provider"
                            checked={provider === candidate}
                            disabled={readOnly}
                            onChange={() => { setProvider(candidate); setResult(null); }}
                        />
                        <span>
                            {candidate === 'ollama' ? t.setup.keyProviderOllama : providerName(t, candidate)}
                            {candidate === 'ollama' && <small>{t.setup.keyProviderOllamaHint}</small>}
                        </span>
                    </label>
                ))}
            </fieldset>

            {/* Ollama runs on the table's machine and takes no key: asking for
                one would be asking for something that does not exist. */}
            {provider !== 'ollama' && (
                <label>
                    <span>{t.aiSettings.keysTitle}</span>
                    <div className="ai-credential__row">
                        <input
                            type="password"
                            value={draft}
                            autoComplete="off"
                            placeholder={t.aiSettings.keyPlaceholder}
                            disabled={readOnly || actions.busy}
                            onChange={(event) => setDraft(event.target.value)}
                        />
                        <button
                            type="button"
                            className="primary"
                            disabled={readOnly || actions.busy || draft.trim() === ''}
                            onClick={saveAndVerify}
                        >
                            {t.setup.keySaveAndVerify}
                        </button>
                    </div>
                    {PROVIDER_CONSOLE[provider] && (
                        <small>
                            <a href={PROVIDER_CONSOLE[provider]!} target="_blank" rel="noreferrer noopener">
                                {PROVIDER_CONSOLE[provider]}
                            </a>
                        </small>
                    )}
                    {credential?.configured && credential.hint && (
                        <small className="status">{t.setup.keyStored(credential.hint)}</small>
                    )}
                </label>
            )}

            {result && (
                <p className={result.status === 'OK' ? 'status' : 'form-error'} role="status">
                    {result.status === 'OK' ? t.setup.keyVerified : t.aiSettings.testAuthFailed}
                </p>
            )}

            {/*
              * Google's free AI Studio tier uses what it is sent to improve its
              * own products, models included. We never train on anything, but
              * under BYOK the key is the table's — so this is said at the moment
              * the key is pasted, not in a policy page nobody opens.
              */}
            {provider === 'gemini' && (
                <p className="settings-hint settings-hint--warn">{t.aiSettings.freeTierTrainingWarning}</p>
            )}

            <FormFeedback error={actions.error} saved={false} savedLabel="" />
        </section>
    );
}

/** Step two: the two groups, already filtered by what step one configured. */
function ModelsStep({ guildId, readOnly }: { guildId: string; readOnly: boolean }) {
    const t = useT();
    const settings = useGuildAiSettings(guildId);
    const actions = useGuildAiSettingsActions(guildId);

    const [quality, setQuality] = useState<TierChoice | null>(null);
    const [fast, setFast] = useState<TierChoice | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        if (!settings.data) return;
        setQuality(settings.data.quality);
        setFast(settings.data.fast);
    }, [settings.data]);

    if (!settings.data) return null;

    return (
        <form
            className="settings-section"
            onSubmit={async (event) => {
                event.preventDefault();
                setSaved(false);
                if (await actions.saveTiers({ quality, fast })) setSaved(true);
            }}
        >
            <h2>{t.setup.modelsTitle}</h2>
            <p className="settings-hint">{t.setup.modelsIntro}</p>

            <TierPicker
                guildId={guildId}
                kind="quality"
                label={t.aiSettings.tierQuality}
                hint={t.aiSettings.tierQualityHint}
                value={quality}
                disabled={readOnly || actions.busy}
                credentials={settings.data.credentials}
                onChange={setQuality}
            />
            <TierPicker
                guildId={guildId}
                kind="fast"
                label={t.aiSettings.tierFast}
                hint={t.aiSettings.tierFastHint}
                value={fast}
                disabled={readOnly || actions.busy}
                credentials={settings.data.credentials}
                onChange={setFast}
            />

            <FormFeedback error={actions.error} saved={saved} savedLabel={t.aiSettings.saved} />
            <button type="submit" className="primary" disabled={readOnly || actions.busy}>
                {t.aiSettings.save}
            </button>
        </form>
    );
}

/** Step four: somewhere to record into. Skipped when the server already has one. */
function CampaignStep({
    guildId, readOnly, existing,
}: {
    guildId: string;
    readOnly: boolean;
    existing: string | undefined;
}) {
    const t = useT();
    const { locale } = useLocale();
    const { create, busy, error } = useCreateCampaign(guildId);

    const [name, setName] = useState('');
    // The most likely spoken language is the one the site is being used in.
    const [language, setLanguage] = useState<string>(locale);
    const [year, setYear] = useState('');
    const [partyName, setPartyName] = useState('');
    const [created, setCreated] = useState(false);

    if (existing) {
        return (
            <section className="settings-section">
                <h2>{t.setup.campaignTitle}</h2>
                <p className="status">{t.setup.campaignAlready(existing)}</p>
            </section>
        );
    }

    return (
        <form
            className="settings-section"
            onSubmit={async (event) => {
                event.preventDefault();
                const parsedYear = Number.parseInt(year.trim(), 10);
                const result = await create({
                    name: name.trim(),
                    language,
                    ...(Number.isFinite(parsedYear) ? { current_year: parsedYear } : {}),
                    ...(partyName.trim() ? { party_name: partyName.trim() } : {}),
                });
                if (result) setCreated(true);
            }}
        >
            <h2>{t.setup.campaignTitle}</h2>
            <p className="settings-hint">{t.setup.campaignIntro}</p>

            <label>
                <span>{t.campaignAdmin.name}</span>
                <input value={name} disabled={readOnly || busy} onChange={(event) => setName(event.target.value)} />
            </label>

            <label>
                <span>{t.campaignAdmin.language}</span>
                <select value={language} disabled={readOnly || busy} onChange={(event) => setLanguage(event.target.value)}>
                    {(Object.keys(LOCALES) as Locale[]).map((code) => (
                        <option key={code} value={code}>{LANGUAGE_NAMES[code]}</option>
                    ))}
                </select>
            </label>

            <label>
                <span>{t.campaignAdmin.year}</span>
                <input value={year} disabled={readOnly || busy} onChange={(event) => setYear(event.target.value)} />
            </label>

            <label>
                <span>{t.campaignAdmin.partyName}</span>
                <input
                    value={partyName}
                    disabled={readOnly || busy}
                    onChange={(event) => setPartyName(event.target.value)}
                />
            </label>

            <FormFeedback error={error} saved={created} savedLabel={t.campaignAdmin.saved} />
            <button type="submit" className="primary" disabled={readOnly || busy || name.trim() === ''}>
                {t.campaignAdmin.createCta}
            </button>
        </form>
    );
}

/**
 * Step five: what is left, and it is not AI.
 *
 * `$listen` checks two more things before it records — the world is configured,
 * and whoever starts it is marked as recording. Neither belongs to this page,
 * so neither is duplicated here: they are named, with a link each.
 */
function ReadyStep({
    guildId, campaignId, outstanding,
}: {
    guildId: string;
    campaignId: number | undefined;
    outstanding: number;
}) {
    const t = useT();

    return (
        <section className="settings-section">
            <h2>{t.setup.readyTitle}</h2>
            <p className={outstanding === 0 ? 'status' : 'form-error'} role="status">
                {outstanding === 0 ? t.setup.readyIntro : t.setup.checklistOutstanding(String(outstanding))}
            </p>

            <ul className="setup-checklist__list">
                <li className="setup-checklist__row">
                    <span className="setup-checklist__label">{t.setup.readyWorld}</span>
                    <span className="setup-checklist__detail">{t.setup.readyWorldHint}</span>
                </li>
                <li className="setup-checklist__row">
                    <span className="setup-checklist__label">{t.setup.readyNickname}</span>
                    <span className="setup-checklist__detail">{t.setup.readyNicknameHint}</span>
                </li>
            </ul>

            {campaignId !== undefined && (
                <p>
                    <Link className="arcane-button" to={`/guilds/${guildId}/campaigns/${campaignId}/settings`}>
                        {t.setup.readyGoToCampaign}
                    </Link>
                </p>
            )}
        </section>
    );
}
