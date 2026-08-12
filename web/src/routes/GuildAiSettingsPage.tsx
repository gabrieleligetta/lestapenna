import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    useGuildAiSettings,
    useGuildAiSettingsActions,
    useProviderModels,
} from '../api/hooks';
import type {
    AiCredentialStatus,
    AiCredentialTestResult,
    AiProvider,
    AiTier,
    SecretVerifyStatus,
    TierChoice,
} from '../api/types';
import { useLocale, useT } from '../i18n';
import { ConfirmModal } from '../components/ConfirmModal';
import { ErrorState, Loading } from '../components/StateViews';
import { TranscriptionSettings } from './TranscriptionSettings';
import { ModelSelect } from '../components/ModelSelect';
import { PROVIDER_CONSOLE, providerName } from '../components/aiLabels';
import { SessionCostPanel } from './SessionCostPanel';
import { FormFeedback } from '../components/FormFeedback';


/**
 * The selectable providers: only the ones that cover the whole pipeline on their own.
 *
 * Anthropic does not transcribe and has no embedding models; Ollama Cloud does
 * not transcribe. A table configured on them would stop halfway through a
 * session, and would find out after recording. `ollama` stays because it is not
 * a key but the table's own hardware, and together with its PC for
 * transcription it gives a complete flow at zero cost.
 */
const ALL_PROVIDERS: AiProvider[] = ['openai', 'gemini', 'ollama'];

/**
 * The table's keys and models.
 *
 * Two selects, not nine: the pipeline has nine phases, but anyone who does not
 * know it has no way of choosing phase by phase, and the difference that really
 * matters is the economic one between the group that runs a few times on long
 * prompts and the group that runs hundreds of times on mechanical tasks.
 *
 * The key fields are **never** pre-filled: the value never comes back from any
 * route. Of a stored credential we only show the `hint`.
 */
export function GuildAiSettingsPage() {
    const { guildId = '' } = useParams();
    const t = useT();
    const settings = useGuildAiSettings(guildId);
    const actions = useGuildAiSettingsActions(guildId);

    const [quality, setQuality] = useState<TierChoice | null>(null);
    const [fast, setFast] = useState<TierChoice | null>(null);
    const [imageModel, setImageModel] = useState<TierChoice | null>(null);
    const [saved, setSaved] = useState(false);
    const [pendingRemoval, setPendingRemoval] = useState<AiProvider | null>(null);
    const [testResults, setTestResults] = useState<Partial<Record<AiProvider, AiCredentialTestResult>>>({});

    useEffect(() => {
        if (!settings.data) return;
        setQuality(settings.data.quality);
        setFast(settings.data.fast);
        setImageModel(settings.data.image);
    }, [settings.data]);

    if (settings.isLoading) return <Loading />;
    if (settings.isError && !settings.data) return <ErrorState error={settings.error} />;
    if (!settings.data) return null;

    const data = settings.data;
    // Reading only requires being a server member; changing keys and models does
    // not: they belong to the server, and a campaign master is not its administrator.
    const readOnly = !data.can_manage;

    async function saveTiers(event: React.FormEvent) {
        event.preventDefault();
        setSaved(false);
        const result = await actions.saveTiers({ quality, fast, image: imageModel });
        if (result) setSaved(true);
    }

    async function test(provider: AiProvider) {
        const result = await actions.testKey(provider);
        if (result) setTestResults((prev) => ({ ...prev, [provider]: result }));
    }

    return (
        <div className="settings-page">
            <h1>{t.aiSettings.title}</h1>
            <p className="settings-intro">{t.aiSettings.intro}</p>

            <p className={data.ready ? 'status' : 'form-error'} role="status">
                {data.ready ? t.aiSettings.ready : t.aiSettings.notReady}
            </p>
            {readOnly && <p className="settings-hint">{t.aiSettings.manageOnly}</p>}

            <section className="settings-section">
                <h2>{t.aiSettings.keysTitle}</h2>
                <p className="settings-hint">{t.aiSettings.keysIntro}</p>

                {data.credentials.map((credential) => (
                    <CredentialRow
                        key={credential.provider}
                        credential={credential}
                        busy={actions.busy || readOnly}
                        result={testResults[credential.provider]}
                        onSave={(key) => actions.saveKey(credential.provider, key)}
                        onTest={() => test(credential.provider)}
                        onRemove={() => setPendingRemoval(credential.provider)}
                    />
                ))}

                <p className="settings-hint">{t.aiSettings.localNoKey}</p>
            </section>

            <form className="settings-section" onSubmit={saveTiers}>
                <h2>{t.aiSettings.modelsTitle}</h2>
                <p className="settings-hint">{t.aiSettings.modelsIntro}</p>

                <TierPicker
                    guildId={guildId}
                    kind="quality"
                    label={t.aiSettings.tierQuality}
                    hint={t.aiSettings.tierQualityHint}
                    value={quality}
                    disabled={actions.busy || readOnly}
                    onChange={setQuality}
                />
                <TierPicker
                    guildId={guildId}
                    kind="fast"
                    label={t.aiSettings.tierFast}
                    hint={t.aiSettings.tierFastHint}
                    value={fast}
                    disabled={actions.busy || readOnly}
                    onChange={setFast}
                />

                <TierPicker
                    guildId={guildId}
                    kind="image"
                    label={t.aiSettings.imageTitle}
                    hint={t.aiSettings.imageIntro}
                    value={imageModel}
                    disabled={actions.busy || readOnly}
                    emptyHint={t.aiSettings.imageNone}
                    onChange={setImageModel}
                />

                <FormFeedback error={actions.error} saved={saved} savedLabel={t.aiSettings.saved} />

                <button type="submit" disabled={actions.busy || readOnly}>{t.aiSettings.save}</button>
            </form>

            <TranscriptionSettings guildId={guildId} readOnly={readOnly} />

            <SessionCostPanel guildId={guildId} readOnly={readOnly} />

            <section className="settings-section">
                <h2>{t.aiSettings.effectiveTitle}</h2>
                <p className="settings-hint">{t.aiSettings.effectiveIntro}</p>
                <EffectiveTable phases={data.effective} phaseLabel={t.aiSettings.phase} />
            </section>

            <ConfirmModal
                open={pendingRemoval !== null}
                title={t.aiSettings.removeKey}
                question={pendingRemoval ? t.aiSettings.removeKeyConfirm(providerName(t, pendingRemoval)) : ''}
                busy={actions.busy}
                error={actions.error}
                confirmLabel={t.aiSettings.removeKey}
                busyLabel={t.common.loading}
                onClose={() => setPendingRemoval(null)}
                onConfirm={async () => {
                    if (!pendingRemoval) return;
                    await actions.removeKey(pendingRemoval);
                    setTestResults((prev) => ({ ...prev, [pendingRemoval]: undefined }));
                    setPendingRemoval(null);
                }}
            />
        </div>
    );
}

function CredentialRow({
    credential, busy, result, onSave, onTest, onRemove,
}: {
    credential: AiCredentialStatus;
    busy: boolean;
    result?: AiCredentialTestResult;
    onSave: (key: string) => Promise<unknown>;
    onTest: () => void;
    onRemove: () => void;
}) {
    const t = useT();
    const [draft, setDraft] = useState('');
    const console_ = PROVIDER_CONSOLE[credential.provider];

    // The stored state counts as much as the last test's: a key that ran out of
    // credit during a session was marked by the system, not by a click, and that
    // signal has to stay visible after a reload.
    const status: SecretVerifyStatus | null = result?.status ?? credential.verify_status;

    return (
        <div className="ai-credential">
            <div className="ai-credential__head">
                <strong>{providerName(t, credential.provider)}</strong>
                <span className={credential.configured ? 'status' : 'settings-hint'}>
                    {credential.configured && credential.hint
                        ? t.aiSettings.keyConfigured(credential.hint)
                        : t.aiSettings.keyMissing}
                </span>
            </div>

            <div className="ai-credential__row">
                <input
                    type="password"
                    value={draft}
                    autoComplete="off"
                    placeholder={t.aiSettings.keyPlaceholder}
                    disabled={busy}
                    onChange={(event) => setDraft(event.target.value)}
                />
                <button
                    type="button"
                    disabled={busy || draft.trim() === ''}
                    onClick={async () => {
                        await onSave(draft.trim());
                        setDraft(''); // the value is not kept in the page longer than needed
                    }}
                >
                    {t.aiSettings.saveKey}
                </button>
                {credential.configured && (
                    <>
                        <button type="button" disabled={busy} onClick={onTest}>{t.aiSettings.testKey}</button>
                        <button type="button" className="danger-button" disabled={busy} onClick={onRemove}>
                            {t.aiSettings.removeKey}
                        </button>
                    </>
                )}
            </div>

            {status && <StatusLine status={status} console={console_} />}

            {/*
              * Free tiers that train on what you send them.
              *
              * Discord's Developer Policy (#21) forbids using message content
              * obtained through the APIs to train AI models. We never do — but
              * under BYOK the key is the table's, and Google's free AI Studio
              * tier explicitly uses submitted content to improve its products,
              * models included. We cannot prevent that; the least we owe is to
              * say so at the moment the key is pasted, not in a policy page
              * nobody opens.
              */}
            {credential.provider === 'gemini' && (
                <p className="settings-hint settings-hint--warn">{t.aiSettings.freeTierTrainingWarning}</p>
            )}
        </div>
    );
}

function StatusLine({ status, console }: { status: SecretVerifyStatus; console: string | null }) {
    const t = useT();
    const message = {
        OK: t.aiSettings.testOk,
        AUTH_FAILED: t.aiSettings.testAuthFailed,
        QUOTA_EXHAUSTED: t.aiSettings.testQuotaExhausted,
        UNREACHABLE: t.aiSettings.testUnreachable,
        UNDECRYPTABLE: t.aiSettings.testUndecryptable,
    }[status];

    return (
        <p className={status === 'OK' ? 'status' : 'form-error'} role="status">
            {message}
            {/* No provider exposes the remaining balance: the most we
                can do is take the user where they can actually see it. */}
            {status === 'QUOTA_EXHAUSTED' && console && (
                <> <a href={console} target="_blank" rel="noreferrer noopener">{console}</a></>
            )}
        </p>
    );
}

/**
 * One provider-and-model choice.
 *
 * `kind` is not always one of the two groups: portraits are a third selection,
 * drawn from a list of image models rather than text ones. Everything else about
 * the control is identical, so it is the same component with a different list —
 * a second picker would have been this one with one line changed.
 */
function TierPicker({
    guildId, kind, label, hint, value, disabled, onChange, emptyHint,
}: {
    guildId: string;
    kind: AiTier | 'image';
    label: string;
    hint: string;
    value: TierChoice | null;
    disabled: boolean;
    onChange: (choice: TierChoice | null) => void;
    /** Shown when the chosen provider offers nothing of this kind. */
    emptyHint?: string;
}) {
    const t = useT();
    const { locale } = useLocale();
    const models = useProviderModels(guildId, value?.provider ?? null);
    const options = kind === 'quality'
        ? models.data?.quality
        : kind === 'fast'
            ? models.data?.fast
            : models.data?.image;

    return (
        <fieldset className="ai-tier">
            <legend>{label}</legend>
            <p className="settings-hint">{hint}</p>

            <label>
                <span>{t.aiSettings.provider}</span>
                <select
                    value={value?.provider ?? ''}
                    disabled={disabled}
                    onChange={(event) => {
                        const provider = event.target.value as AiProvider | '';
                        onChange(provider === '' ? null : { provider, model: '' });
                    }}
                >
                    <option value="">{t.aiSettings.useDefault}</option>
                    {ALL_PROVIDERS.map((provider) => (
                        <option key={provider} value={provider}>{providerName(t, provider)}</option>
                    ))}
                </select>
            </label>

            {value && (
                <label>
                    <span>{t.aiSettings.model}</span>
                    <ModelSelect
                        value={value.model}
                        options={options ?? []}
                        disabled={disabled}
                        allowEmpty
                        onChange={(model) => onChange({ ...value, model })}
                    />
                    {/* A provider with no model of this kind is a real state —
                        Ollama has no image endpoint — and saying so beats an
                        empty select the reader has to interpret. */}
                    {emptyHint && models.data && (options ?? []).length === 0 && (
                        <small className="form-error">{emptyHint}</small>
                    )}
                    {models.data?.refreshed_at
                        ? <small>{t.aiSettings.catalogRefreshed(
                            new Date(models.data.refreshed_at).toLocaleDateString(locale),
                        )}</small>
                        : <small>{t.aiSettings.catalogCurated}</small>}
                </label>
            )}
        </fieldset>
    );
}

export function EffectiveTable({
    phases, phaseLabel,
}: {
    phases: Array<{ phase: string; provider: AiProvider; model: string }>;
    phaseLabel: string;
}) {
    const t = useT();
    return (
        <div className="table-scroll">
            <table className="ai-effective">
                <thead>
                    <tr>
                        <th>{phaseLabel}</th>
                        <th>{t.aiSettings.provider}</th>
                        <th>{t.aiSettings.model}</th>
                    </tr>
                </thead>
                <tbody>
                    {phases.map((phase) => (
                        <tr key={phase.phase}>
                            <td>{phase.phase}</td>
                            <td>{providerName(t, phase.provider)}</td>
                            <td><code>{phase.model}</code></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
