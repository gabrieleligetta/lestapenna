import { useEffect, useState } from 'react';
import {
    useProviderModels,
    useRemoteWhisperModels,
    useTranscriptionActions,
    useTranscriptionSettings,
    useWakeMethods,
} from '../api/hooks';
import type {
    AiModelOption,
    TranscriptionEngine,
    TranscriptionProbe,
    WakeMethod,
} from '../api/types';
import { ModelSelect } from '../components/ModelSelect';
import { useT } from '../i18n';
import { FormFeedback } from '../components/FormFeedback';

/** Hours of speech in a typical session, for the estimate. */
const TYPICAL_SESSION_HOURS = 4;

/**
 * How this table turns audio into text.
 *
 * The two routes never cross on their own: falling back from a switched-off PC
 * to a paid model would spend money nobody authorized, over a fault that is
 * often solved by turning a computer on. That is why the choice is exclusive
 * and switching the PC on is a button of its own.
 */
export function TranscriptionSettings({ guildId, readOnly }: { guildId: string; readOnly: boolean }) {
    const t = useT();
    const settings = useTranscriptionSettings(guildId);
    const methods = useWakeMethods(guildId);
    const actions = useTranscriptionActions(guildId);

    const [engine, setEngine] = useState<TranscriptionEngine | ''>('');
    const [url, setUrl] = useState('');
    const [mac, setMac] = useState('');
    const [wakeMethodId, setWakeMethodId] = useState('udp');
    const [wakeOptions, setWakeOptions] = useState<Record<string, string>>({});
    const [shutdown, setShutdown] = useState(false);
    const [cloudModel, setCloudModel] = useState('gpt-4o-mini-transcribe');
    const [remoteModel, setRemoteModel] = useState('');
    const [tokenDraft, setTokenDraft] = useState('');
    const [probe, setProbe] = useState<TranscriptionProbe | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        const data = settings.data;
        if (!data) return;
        setEngine(data.engine ?? '');
        setUrl(data.remote.url ?? '');
        setMac(data.remote.wake.mac_address ?? '');
        setWakeMethodId(data.remote.wake.method);
        setWakeOptions(
            Object.fromEntries(
                Object.entries(data.remote.wake.options).map(([key, value]) => [key, String(value ?? '')]),
            ),
        );
        setShutdown(data.remote.shutdown_enabled);
        setCloudModel(data.cloud.model);
        setRemoteModel(data.remote.model ?? '');
    }, [settings.data]);

    // Both providers, because the choice of transcription model is exactly
    // where a table on Gemini may still want OpenAI's dedicated endpoint — or
    // the other way round, to keep a single key for the whole flow.
    const openaiModels = useProviderModels(guildId, 'openai');
    const geminiModels = useProviderModels(guildId, 'gemini');
    const remoteModels = useRemoteWhisperModels(guildId, engine === 'remote');

    const cloudModels: AiModelOption[] = [
        ...(openaiModels.data?.transcription ?? []),
        ...(geminiModels.data?.transcription ?? []),
    ];
    const installedModels: AiModelOption[] = (remoteModels.data?.models ?? []).map((id) => ({
        id,
        label: null,
        recommended: id === remoteModels.data?.current,
        input_per_million: null,
        output_per_million: null,
        per_minute_usd: null,
        per_image_usd: null,
        context_tokens: null,
        runs_on_your_hardware: true,
    }));

    if (!settings.data) return null;
    const data = settings.data;
    const method: WakeMethod | undefined = methods.data?.find((entry) => entry.id === wakeMethodId);
    const disabled = readOnly || actions.busy;

    async function save() {
        setSaved(false);
        const result = await actions.save({
            engine: engine === '' ? null : engine,
            remote_url: url.trim() || null,
            shutdown_enabled: shutdown,
            wake: {
                mac_address: mac.trim() || null,
                method: wakeMethodId,
                options: wakeOptions,
            },
            // The provider is not sent: the server infers it from the model,
            // and it is the only side that knows the refreshed catalogue.
            ...(cloudModel.trim() ? { cloud_model: cloudModel.trim() } : {}),
            remote_model: remoteModel.trim() || null,
        });
        if (result) setSaved(true);
    }

    const perMinute = data.cloud_usd_per_minute;

    return (
        <section className="settings-section">
            <h2>{t.transcription.title}</h2>
            <p className="settings-hint">{t.transcription.intro}</p>

            {!data.usable && (
                <p className="form-error" role="alert">
                    {data.reason === 'NO_CLOUD_KEY' ? t.transcription.noCloudKey : t.transcription.notUsable}
                </p>
            )}

            <fieldset className="ai-tier">
                <legend>{t.transcription.title}</legend>

                <label className="settings-form__check">
                    <input
                        type="radio"
                        name="transcription-engine"
                        checked={engine === 'remote'}
                        disabled={disabled}
                        onChange={() => setEngine('remote')}
                    />
                    <span>
                        {t.transcription.engineRemote}
                        <small>{t.transcription.engineRemoteHint}</small>
                    </span>
                </label>

                <label className="settings-form__check">
                    <input
                        type="radio"
                        name="transcription-engine"
                        checked={engine === 'cloud'}
                        disabled={disabled}
                        onChange={() => setEngine('cloud')}
                    />
                    <span>
                        {t.transcription.engineCloud}
                        <small>{t.transcription.engineCloudHint}</small>
                    </span>
                </label>
            </fieldset>

            {engine === 'remote' && (
                <>
                    <label>
                        <span>{t.transcription.machineUrl}</span>
                        <input
                            value={url}
                            disabled={disabled}
                            placeholder="http://100.x.y.z:3001"
                            onChange={(event) => setUrl(event.target.value)}
                        />
                        <small>{t.transcription.machineUrlHint}</small>
                    </label>

                    <label>
                        <span>{t.transcription.authToken}</span>
                        <div className="ai-credential__row">
                            <input
                                type="password"
                                value={tokenDraft}
                                autoComplete="off"
                                disabled={disabled}
                                onChange={(event) => setTokenDraft(event.target.value)}
                            />
                            <button
                                type="button"
                                disabled={disabled || tokenDraft.trim() === ''}
                                onClick={async () => {
                                    await actions.saveAuthToken(tokenDraft.trim());
                                    setTokenDraft('');
                                }}
                            >
                                {t.aiSettings.saveKey}
                            </button>
                        </div>
                        <small>{t.transcription.authTokenHint}</small>
                        {data.remote.auth_token_configured && (
                            <small className="status">{t.transcription.authTokenConfigured}</small>
                        )}
                    </label>

                    <label>
                        <span>{t.campaignTranscription.model}</span>
                        <ModelSelect
                            value={remoteModel}
                            options={installedModels}
                            disabled={disabled}
                            allowEmpty
                            emptyLabel={t.aiSettings.useDefault}
                            onChange={setRemoteModel}
                        />
                        {/* The machine being off is its normal state, not an
                            error: a choice made now still saves. */}
                        {remoteModels.data?.reason === 'UNREACHABLE' && (
                            <small>{t.campaignTranscription.pcOff}</small>
                        )}
                        {remoteModels.data?.reason === 'UNAUTHORIZED' && (
                            <small className="form-error">{t.campaignTranscription.pcUnauthorized}</small>
                        )}
                    </label>

                    <p className="settings-hint">{t.transcription.freeOnOwnMachine}</p>

                    <div className="ai-credential__row">
                        <button type="button" disabled={disabled} onClick={async () => setProbe(await actions.test())}>
                            {t.transcription.test}
                        </button>
                        {/* A separate action from the test: waking a machine
                            takes minutes, and hiding it inside the test would
                            make a computer that is merely booting look broken. */}
                        <button type="button" disabled={disabled || !mac} onClick={async () => setProbe(await actions.wake())}>
                            {t.transcription.wake}
                        </button>
                    </div>

                    {probe && (
                        <p className={probe.status === 'OK' ? 'status' : 'form-error'} role="status">
                            {{
                                OK: t.transcription.testOk,
                                UNREACHABLE: t.transcription.testUnreachable,
                                UNAUTHORIZED: t.transcription.testUnauthorized,
                                NOT_CONFIGURED: t.transcription.testNotConfigured,
                            }[probe.status]}
                        </p>
                    )}

                    <label className="settings-form__check">
                        <input
                            type="checkbox"
                            checked={shutdown}
                            disabled={disabled}
                            onChange={(event) => setShutdown(event.target.checked)}
                        />
                        <span>
                            {t.transcription.shutdown}
                            <small>{t.transcription.shutdownHint}</small>
                        </span>
                    </label>

                    <fieldset className="ai-tier">
                        <legend>{t.transcription.wakeTitle}</legend>
                        <p className="settings-hint">{t.transcription.wakeIntro}</p>

                        <label>
                            <span>{t.transcription.macAddress}</span>
                            <input
                                value={mac}
                                disabled={disabled}
                                placeholder="AA:BB:CC:DD:EE:FF"
                                onChange={(event) => setMac(event.target.value)}
                            />
                            <small>{t.transcription.macAddressHint}</small>
                        </label>

                        <label>
                            <span>{t.transcription.wakeMethod}</span>
                            <select
                                value={wakeMethodId}
                                disabled={disabled}
                                onChange={(event) => {
                                    setWakeMethodId(event.target.value);
                                    setWakeOptions({});
                                }}
                            >
                                {(methods.data ?? []).map((entry) => (
                                    <option key={entry.id} value={entry.id}>{entry.label}</option>
                                ))}
                            </select>
                            {method && <small>{method.description}</small>}
                        </label>

                        {/* The method declares its own fields: this page
                            knows nothing about routers, and adding one does
                            not touch it. */}
                        {method?.fields.map((field) => (
                            <WakeFieldInput
                                key={field.name}
                                field={field}
                                method={method.id}
                                value={wakeOptions[field.name] ?? ''}
                                configured={data.remote.wake.configured_secrets.includes(field.name)}
                                disabled={disabled}
                                onChange={(value) => setWakeOptions((current) => ({ ...current, [field.name]: value }))}
                                onSaveSecret={(value) => actions.saveWakeSecret(method.id, field.name, value)}
                            />
                        ))}
                    </fieldset>
                </>
            )}

            {engine === 'cloud' && (
                <>
                    <label>
                        <span>{t.transcription.cloudModel}</span>
                        <ModelSelect
                            value={cloudModel}
                            options={cloudModels}
                            disabled={disabled}
                            onChange={setCloudModel}
                        />
                        <small>{t.transcription.cloudModelHint}</small>
                    </label>

                    {/* The price is shown before choosing, not after the fact. */}
                    {perMinute === null ? (
                        <p className="settings-hint">{t.transcription.priceUnknown}</p>
                    ) : (
                        <p className="settings-hint">
                            {t.transcription.pricePerMinute(perMinute.toFixed(4))}
                            {' '}
                            {t.transcription.sessionEstimate(
                                String(TYPICAL_SESSION_HOURS),
                                (perMinute * 60 * TYPICAL_SESSION_HOURS).toFixed(2),
                            )}
                        </p>
                    )}
                </>
            )}

            <FormFeedback error={actions.error} saved={saved} savedLabel={t.transcription.saved} />

            <button type="button" disabled={disabled} onClick={save}>{t.transcription.save}</button>
        </section>
    );
}

function WakeFieldInput({
    field, method, value, configured, disabled, onChange, onSaveSecret,
}: {
    field: WakeMethod['fields'][number];
    method: string;
    value: string;
    configured: boolean;
    disabled: boolean;
    onChange: (value: string) => void;
    onSaveSecret: (value: string) => Promise<unknown>;
}) {
    const t = useT();
    const [draft, setDraft] = useState('');

    // A secret does not mix with the other settings: it goes to the vault, with
    // its own write path, and never comes back from a GET.
    if (field.secret) {
        return (
            <label>
                <span>{field.label}</span>
                <div className="ai-credential__row">
                    <input
                        type="password"
                        value={draft}
                        autoComplete="off"
                        disabled={disabled}
                        placeholder={field.placeholder ?? ''}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <button
                        type="button"
                        disabled={disabled || draft.trim() === ''}
                        onClick={async () => {
                            await onSaveSecret(draft.trim());
                            setDraft('');
                        }}
                    >
                        {t.aiSettings.saveKey}
                    </button>
                </div>
                {field.hint && <small>{field.hint}</small>}
                {configured && <small className="status">{t.transcription.authTokenConfigured}</small>}
            </label>
        );
    }

    return (
        <label>
            <span>{field.label}</span>
            <input
                type={field.kind === 'number' ? 'number' : 'text'}
                value={value}
                disabled={disabled}
                placeholder={field.placeholder ?? ''}
                onChange={(event) => onChange(event.target.value)}
                data-wake-method={method}
            />
            {field.hint && <small>{field.hint}</small>}
        </label>
    );
}
