import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch, ApiError } from '../api/client';
import { useLocale, useT } from '../i18n';
import { Modal } from './Modal';
import { Icon } from './icons';
import { ScreenshotEditor } from './ScreenshotEditor';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_DESCRIPTION = 4000;
const MAX_STEPS = 2000;

type ReportType =
    | 'BUG' | 'UI' | 'UX' | 'DATA' | 'FLOW'
    | 'PERFORMANCE' | 'SECURITY' | 'CONTENT' | 'FEATURE' | 'OTHER';

const TYPE_ORDER: ReportType[] = [
    'BUG', 'UI', 'UX', 'DATA', 'FLOW',
    'PERFORMANCE', 'SECURITY', 'CONTENT', 'FEATURE', 'OTHER',
];

type Severity = 'low' | 'medium' | 'high' | 'critical';
const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

interface CreatedReport {
    number: number;
    id: string;
    status: string;
    createdAt: number;
}

/** form = normal modal; capturing = modal hidden, browser shows its screen-source
 * picker; editing = wide modal with the screenshot editor. */
type Mode = 'form' | 'capturing' | 'editing';
type SourceMode = 'upload' | 'capture';

interface ReportDialogProps {
    open: boolean;
    onClose: () => void;
}

/** Capture is preselected when the Screen Capture API is available; otherwise
 * the dialog falls back to upload-only and the toggle is hidden. */
function defaultSourceMode(): SourceMode {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
        ? 'capture'
        : 'upload';
}

export function ReportDialog({ open, onClose }: ReportDialogProps) {
    const t = useT();
    const { locale } = useLocale();
    const params = useParams<{ guildId?: string; campaignId?: string }>();
    // Evaluated per render so tests (and browsers that gain the API later) see
    // the current state instead of a value captured at module load.
    const captureSupported =
        typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

    const [type, setType] = useState<ReportType>('BUG');
    const [severity, setSeverity] = useState<Severity | ''>('medium');
    const [description, setDescription] = useState('');
    const [steps, setSteps] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [filePreview, setFilePreview] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<CreatedReport | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Mirror of filePreview read inside the reset effect's cleanup. The effect
    // depends on [open] only, so its closure would otherwise capture a stale
    // preview URL and never revoke the real one between two reports.
    const previewRef = useRef<string | null>(null);
    previewRef.current = filePreview;

    // Screenshot capture/editor state.
    const [mode, setMode] = useState<Mode>('form');
    const [sourceMode, setSourceMode] = useState<SourceMode>(defaultSourceMode);
    const [capturedFrame, setCapturedFrame] = useState<HTMLCanvasElement | null>(null);

    // Reset the form each time the modal is opened so a previous submission
    // doesn't linger when the user reports a second issue.
    useEffect(() => {
        if (!open) return;
        setType('BUG');
        setSeverity('medium');
        setDescription('');
        setSteps('');
        setFile(null);
        setFilePreview(null);
        setError(null);
        setBusy(false);
        setResult(null);
        setMode('form');
        setSourceMode(defaultSourceMode());
        setCapturedFrame(null);
        return () => {
            // Revoke on close/unmount using the latest preview (ref, not closure).
            if (previewRef.current) URL.revokeObjectURL(previewRef.current);
        };
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    function chooseFile(selected: File | null) {
        if (!selected) {
            setFile(null);
            return;
        }
        if (!ACCEPTED_TYPES.has(selected.type)) {
            setError(t.report.invalidFile);
            return;
        }
        if (selected.size > MAX_FILE_BYTES) {
            setError(t.report.tooLarge);
            return;
        }
        setError(null);
        setFile(selected);
        if (filePreview) URL.revokeObjectURL(filePreview);
        setFilePreview(URL.createObjectURL(selected));
    }

    function removeScreenshot() {
        if (filePreview) URL.revokeObjectURL(filePreview);
        setFile(null);
        setFilePreview(null);
    }

    /** Grab a single frame from the user's chosen screen source via the Screen
     * Capture API. The modal is hidden while the browser shows its native picker
     * so the captured frame shows the actual (buggy) page, not the dialog. */
    async function captureScreen() {
        setError(null);
        setMode('capturing');
        let stream: MediaStream | null = null;
        try {
            // The browser always shows its native source picker (a page cannot
            // capture a screen/tab without an explicit user choice — it's a spec
            // privacy guarantee). These hints make it as frictionless as allowed:
            //   - selfBrowserSurface: 'include'  → recent browsers EXCLUDE the
            //     current tab by default; we must opt in or the tab the user is
            //     reporting from won't even appear.
            //   - preferCurrentTab: true         → (Chrome/Edge) preselects the
            //     current tab in the picker, so the user just hits "Share".
            // The user still confirms once, then lands straight in the editor.
            const constraints = {
                video: { frameRate: 1, displaySurface: 'browser' },
                audio: false,
                preferCurrentTab: true,
                selfBrowserSurface: 'include' as const,
            };
            stream = await navigator.mediaDevices!.getDisplayMedia(
                constraints as DisplayMediaStreamOptions,
            );
            const video = document.createElement('video');
            video.muted = true;
            video.srcObject = stream;
            const ready = new Promise<void>((resolve) => {
                if (video.readyState >= 2) return resolve();
                video.onloadeddata = () => resolve();
            });
            await video.play();
            await ready;
            // One rAF so the first painted frame is the real content, not the picker.
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx || !canvas.width) throw new Error('no-frame');
            ctx.drawImage(video, 0, 0);
            setCapturedFrame(canvas);
            setMode('editing');
        } catch (err) {
            if (err instanceof DOMException && err.name === 'NotAllowedError') {
                // User cancelled the picker / denied — silent return to the form.
                setMode('form');
            } else {
                setError(t.report.captureError);
                setMode('form');
            }
        } finally {
            stream?.getTracks().forEach((track) => track.stop());
        }
    }

    function onEditorConfirm(fileFromEditor: File) {
        if (filePreview) URL.revokeObjectURL(filePreview);
        setFile(fileFromEditor);
        setFilePreview(URL.createObjectURL(fileFromEditor));
        setCapturedFrame(null);
        setMode('form');
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (description.trim().length === 0) {
            setError(t.report.required);
            return;
        }
        if (description.length > MAX_DESCRIPTION || steps.length > MAX_STEPS) {
            setError(t.report.required);
            return;
        }

        const form = new FormData();
        form.append('type', type);
        form.append('description', description.trim());
        if (severity) form.append('severity', severity);
        if (steps.trim()) form.append('steps', steps.trim());
        // Automatic context — the page the user is reporting from.
        form.append('url', window.location.pathname + window.location.search);
        form.append('locale', locale);
        form.append('theme', document.documentElement.dataset.theme ?? '');
        form.append('viewportWidth', String(window.innerWidth));
        form.append('viewportHeight', String(window.innerHeight));
        form.append('userAgent', navigator.userAgent);
        if (params.guildId) form.append('guildId', params.guildId);
        if (params.campaignId) form.append('campaignId', params.campaignId);
        const appVersion = import.meta.env.VITE_APP_VERSION;
        if (typeof appVersion === 'string') form.append('appVersion', appVersion);
        if (file) form.append('screenshot', file);

        setBusy(true);
        setError(null);
        try {
            const created = await apiFetch<CreatedReport>('/reports', { method: 'POST', body: form });
            setResult(created);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : t.report.error);
        } finally {
            setBusy(false);
        }
    }

    const modalOpen = open && mode !== 'capturing';
    const title = mode === 'editing' ? t.report.editorTitle : t.report.title;

    return (
        <>
            {mode === 'capturing' && (
                <div className="report-capturing-pill" role="status">{t.report.capturing}</div>
            )}
            <Modal open={modalOpen} onClose={onClose} title={title} wide={mode === 'editing'}>
                {mode === 'editing' && capturedFrame ? (
                    <ScreenshotEditor
                        source={capturedFrame}
                        onConfirm={onEditorConfirm}
                        onCancel={() => {
                            setCapturedFrame(null);
                            setMode('form');
                        }}
                        onRetake={captureScreen}
                        t={t.report}
                    />
                ) : result ? (
                    <div className="report-success">
                        <h2>{t.report.title}</h2>
                        <p className="modal__subtitle">{t.report.success(result.id)}</p>
                        <div className="report-success__number">#{result.id}</div>
                        <div className="report-form__actions">
                            <button type="button" onClick={onClose} autoFocus>
                                {t.common.back}
                            </button>
                        </div>
                    </div>
                ) : (
                    <form className="report-form" onSubmit={submit}>
                        <h2>{t.report.title}</h2>
                        <p className="modal__subtitle">{t.report.subtitle}</p>

                        <div className="report-form__row">
                            <label>
                                <span>{t.report.type}</span>
                                <select value={type} onChange={(e) => setType(e.target.value as ReportType)}>
                                    {TYPE_ORDER.map((value) => (
                                        <option key={value} value={value}>
                                            {t.report.types[value]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                <span>{t.report.severity}</span>
                                <select
                                    value={severity}
                                    onChange={(e) => setSeverity(e.target.value as Severity | '')}
                                >
                                    <option value="">{t.report.severityNone}</option>
                                    {SEVERITY_ORDER.map((value) => (
                                        <option key={value} value={value}>
                                            {t.report.severities[value]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>

                        <label>
                            <span>{t.report.description}</span>
                            <textarea
                                value={description}
                                maxLength={MAX_DESCRIPTION}
                                onChange={(e) => setDescription(e.target.value)}
                                required
                            />
                        </label>
                        <span className="modal__subtitle">{t.report.descriptionHint}</span>

                        <label>
                            <span>{t.report.steps}</span>
                            <textarea
                                value={steps}
                                maxLength={MAX_STEPS}
                                onChange={(e) => setSteps(e.target.value)}
                            />
                        </label>
                        <span className="modal__subtitle">{t.report.stepsHint}</span>

                        <div>
                            <span>{t.report.screenshot}</span>
                            {filePreview ? (
                                <div className="report-screenshot-preview">
                                    <img src={filePreview} alt="" />
                                    <button
                                        type="button"
                                        className="report-screenshot-preview__remove"
                                        onClick={removeScreenshot}
                                    >
                                        {t.report.removeScreenshot}
                                    </button>
                                </div>
                            ) : captureSupported ? (
                                <>
                                    <div
                                        className="report-source-toggle"
                                        role="group"
                                        aria-label={t.report.screenshot}
                                    >
                                        <button
                                            type="button"
                                            className="report-source-toggle__btn"
                                            aria-pressed={sourceMode === 'upload'}
                                            onClick={() => setSourceMode('upload')}
                                        >
                                            {t.report.sourceUpload}
                                        </button>
                                        <button
                                            type="button"
                                            className="report-source-toggle__btn"
                                            aria-pressed={sourceMode === 'capture'}
                                            onClick={() => setSourceMode('capture')}
                                        >
                                            {t.report.sourceCapture}
                                        </button>
                                    </div>
                                    {sourceMode === 'upload' ? (
                                        <label
                                            className="report-dropzone"
                                            onDragOver={(e) => e.preventDefault()}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                chooseFile(e.dataTransfer.files[0] ?? null);
                                            }}
                                        >
                                            <Icon name="empty" />
                                            <span>{t.report.screenshotChoose}</span>
                                            <span className="modal__subtitle">{t.report.screenshotHint}</span>
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                accept="image/jpeg,image/png,image/webp"
                                                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                                                hidden
                                            />
                                        </label>
                                    ) : (
                                        <div className="report-capture-start">
                                            <Icon name="screen" />
                                            <span>{t.report.captureHint}</span>
                                            <button type="button" onClick={captureScreen}>
                                                <Icon name="screen" />
                                                {t.report.captureStart}
                                            </button>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <label
                                        className="report-dropzone"
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            chooseFile(e.dataTransfer.files[0] ?? null);
                                        }}
                                    >
                                        <Icon name="empty" />
                                        <span>{t.report.screenshotChoose}</span>
                                        <span className="modal__subtitle">{t.report.screenshotHint}</span>
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept="image/jpeg,image/png,image/webp"
                                            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                                            hidden
                                        />
                                    </label>
                                    <span className="modal__subtitle">{t.report.captureUnsupported}</span>
                                </>
                            )}
                        </div>

                        <div aria-live="polite">
                            {error && <span role="alert" className="status-error">{error}</span>}
                        </div>

                        <div className="report-form__actions">
                            <button type="button" onClick={onClose} disabled={busy}>
                                {t.report.cancel}
                            </button>
                            <button type="submit" className="primary" disabled={busy}>
                                {busy ? t.report.sending : t.report.send}
                            </button>
                        </div>
                    </form>
                )}
            </Modal>
        </>
    );
}