import { useEffect, useRef, useState } from 'react';
import { useRemotePcStatus, useTranscriptionActions } from '../api/hooks';
import type { RemotePcStatus, ShutdownResult } from '../api/types';
import { useLocale, useT } from '../i18n';
import { Badge, type BadgeTone } from './Badge';
import { ConfirmModal } from './ConfirmModal';

/** How often to ask, while the machine is coming up. */
const BOOT_POLL_MS = 5_000;

/**
 * The table's own transcription machine: what it is doing, and the two buttons
 * that change it.
 *
 * The settings page could say whether a key existed, which model was chosen and
 * which wake method was configured — everything except the one fact somebody
 * actually opens this page for before a session: **is the computer on**. The
 * probe existed and threw the answer away; waking it was a button that appeared
 * only after choosing a radio and typing a MAC; switching it off was not
 * possible at all from here.
 *
 * Being off is not an error, and nothing here renders it as one.
 */
export function RemotePcPanel({
    guildId, enabled, disabled, shutdownEnabled, shutdownTokenConfigured, canWake,
}: {
    guildId: string;
    /** The table transcribes on its own machine: otherwise there is nothing to show. */
    enabled: boolean;
    /** Read-only viewer, or a write already in flight. */
    disabled: boolean;
    shutdownEnabled: boolean;
    shutdownTokenConfigured: boolean;
    /** A wake needs a MAC address; without one the button has nothing to send to. */
    canWake: boolean;
}) {
    const t = useT();
    const actions = useTranscriptionActions(guildId);

    const [bootStartedAt, setBootStartedAt] = useState<number | null>(null);
    const [bootTimeoutMs, setBootTimeoutMs] = useState(180_000);
    const [elapsed, setElapsed] = useState(0);
    const [askingShutdown, setAskingShutdown] = useState(false);
    const [shutdown, setShutdown] = useState<ShutdownResult | null>(null);

    const booting = bootStartedAt !== null;
    const status = useRemotePcStatus(guildId, enabled, booting ? BOOT_POLL_MS : false);

    // The clock is the page's, not the server's: it ticks between two polls, so
    // «45s of 180s» keeps moving instead of jumping every five seconds.
    useEffect(() => {
        if (bootStartedAt === null) return;
        const id = setInterval(() => setElapsed(Date.now() - bootStartedAt), 1_000);
        return () => clearInterval(id);
    }, [bootStartedAt]);

    // Two ways out of the boot: the machine answers, or its time runs out.
    const answered = status.data?.status === 'OK';
    const expired = booting && elapsed > bootTimeoutMs;
    const bootEnded = useRef(false);
    useEffect(() => {
        if (!booting) { bootEnded.current = false; return; }
        if (answered || expired) {
            bootEnded.current = expired && !answered;
            setBootStartedAt(null);
        }
    }, [booting, answered, expired]);

    if (!enabled) return null;

    async function wake() {
        setShutdown(null);
        const result = await actions.wake();
        if (result?.status !== 'WAKING') return;
        setBootTimeoutMs(result.boot_timeout_ms);
        setElapsed(0);
        setBootStartedAt(Date.now());
    }

    return (
        <section className="remote-pc" aria-label={t.remotePc.title}>
            <div className="remote-pc__head">
                <strong>{t.remotePc.title}</strong>
                <StatusBadgeLine status={status.data} booting={booting} />
            </div>

            <p className="settings-hint">{t.remotePc.intro}</p>

            {status.data?.health && <HealthLine health={status.data.health} />}

            {booting && (
                <p className="status" role="status">
                    {t.remotePc.booting(
                        String(Math.floor(elapsed / 1000)),
                        String(Math.round(bootTimeoutMs / 1000)),
                    )}
                </p>
            )}

            {/* A machine that did not come up in time is not necessarily broken:
                it may still be starting, which is a different thing to do about
                it than fixing the wake settings. */}
            {!booting && bootEnded.current && (
                <p className="form-error" role="status">{t.remotePc.bootTimedOut}</p>
            )}

            <div className="ai-credential__row">
                <button type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>
                    {t.remotePc.recheck}
                </button>
                <button type="button" disabled={disabled || booting || !canWake} onClick={wake}>
                    {t.remotePc.wake}
                </button>
                <button
                    type="button"
                    className="danger-button"
                    disabled={disabled || !shutdownEnabled || !shutdownTokenConfigured}
                    onClick={() => setAskingShutdown(true)}
                >
                    {t.remotePc.shutdown}
                </button>
            </div>

            {/* Why the button cannot be pressed, next to the button. Two
                different gaps, and the remedy for each is a field below. */}
            {!shutdownEnabled && <p className="settings-hint">{t.remotePc.shutdownDisabled}</p>}
            {shutdownEnabled && !shutdownTokenConfigured && (
                <p className="settings-hint">{t.remotePc.shutdownNoToken}</p>
            )}

            {shutdown && <ShutdownLine result={shutdown} />}

            <ConfirmModal
                open={askingShutdown}
                title={t.remotePc.shutdown}
                question={t.remotePc.shutdownQuestion}
                consequences={[t.remotePc.shutdownConsequence]}
                busy={actions.busy}
                error={actions.error}
                confirmLabel={t.remotePc.shutdown}
                busyLabel={t.common.loading}
                onClose={() => setAskingShutdown(false)}
                onConfirm={async () => {
                    const result = await actions.shutdown();
                    setShutdown(result);
                    setAskingShutdown(false);
                    void status.refetch();
                }}
            />
        </section>
    );
}

function StatusBadgeLine({ status, booting }: { status: RemotePcStatus | undefined; booting: boolean }) {
    const t = useT();
    const { locale } = useLocale();

    if (booting) return <Badge tone="warning">{t.remotePc.statusBooting}</Badge>;
    if (!status) return <Badge tone="neutral">{t.remotePc.neverChecked}</Badge>;

    const tone: Record<RemotePcStatus['status'], BadgeTone> = {
        OK: 'success',
        // Off is the normal state of somebody's home computer, so it is neutral
        // rather than the red it used to share with a real misconfiguration.
        UNREACHABLE: 'neutral',
        UNAUTHORIZED: 'danger',
        NOT_CONFIGURED: 'warning',
    };
    const label: Record<RemotePcStatus['status'], string> = {
        OK: t.remotePc.statusOnline,
        UNREACHABLE: t.remotePc.statusOffline,
        UNAUTHORIZED: t.remotePc.statusUnauthorized,
        NOT_CONFIGURED: t.remotePc.statusNotConfigured,
    };

    return (
        <span className="remote-pc__status">
            <Badge tone={tone[status.status]}>{label[status.status]}</Badge>
            <small>{t.remotePc.lastChecked(new Date(status.checked_at).toLocaleTimeString(locale))}</small>
        </span>
    );
}

function HealthLine({ health }: { health: NonNullable<RemotePcStatus['health']> }) {
    const t = useT();

    // The machine may be an older build that reports none of this: a missing
    // figure is left out, never invented.
    const accelerator = health.accelerator ?? (health.gpu === true ? 'GPU' : health.gpu === false ? 'CPU' : null);
    if (!accelerator && !health.model && health.uptime_seconds === null) return null;

    return (
        <p className="settings-hint">
            {accelerator && health.model && t.remotePc.hardware(accelerator, health.model)}
            {accelerator && !health.model && accelerator}
            {!accelerator && health.model && health.model}
            {health.uptime_seconds !== null && ` · ${t.remotePc.uptime(formatUptime(health.uptime_seconds))}`}
        </p>
    );
}

/** An uptime as people say it: 3h 12m, 45m, 20s. */
function formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${Math.floor(seconds)}s`;
}

function ShutdownLine({ result }: { result: ShutdownResult }) {
    const t = useT();

    if (result.status === 'SCHEDULED') {
        return (
            <p className="status" role="status">
                {t.remotePc.shutdownScheduled(String(result.delay_seconds ?? 0))}
            </p>
        );
    }

    const message: Record<Exclude<ShutdownResult['status'], 'SCHEDULED'>, string> = {
        DISABLED: t.remotePc.shutdownDisabled,
        NO_TOKEN: t.remotePc.shutdownNoToken,
        // Not a failure: the session's audio is worth more than the electricity.
        BUSY: t.remotePc.shutdownBusy,
        NOT_CONFIGURED: t.remotePc.statusNotConfigured,
        UNREACHABLE: t.remotePc.statusOffline,
        UNAUTHORIZED: t.remotePc.statusUnauthorized,
    };

    return <p className="form-error" role="status">{message[result.status]}</p>;
}
