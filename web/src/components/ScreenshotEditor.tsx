import { useCallback, useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n/messages';
import { Icon } from './icons';

type ReportMessages = Messages['report'];

/** A drawable source: either an ImageBitmap or a backing <canvas>. */
type Source = ImageBitmap | HTMLCanvasElement;

type Tool = 'crop' | 'pen' | 'arrow' | 'rect' | 'highlight';

type Pt = [number, number]; // natural (source) coordinates

interface Annotation {
    tool: 'pen' | 'arrow' | 'rect' | 'highlight';
    color: string;
    width: number; // natural px
    pts: Pt[]; // polyline for pen/highlight; [start, end] for arrow/rect
}

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface ScreenshotEditorProps {
    source: Source;
    onConfirm: (file: File) => void;
    onCancel: () => void;
    onRetake: () => void;
    t: ReportMessages;
}

const COLORS = ['#ef4444', '#facc15', '#3b82f6', '#ffffff', '#000000'];
const PEN_WIDTH = 3;
const HIGHLIGHT_WIDTH = 18;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_WIDTH = 1920;
const MAX_DISPLAY_WIDTH = 860;

function sourceSize(src: Source): { w: number; h: number } {
    return { w: src.width, h: src.height };
}

function normalizeRect(a: Pt, b: Pt): Rect {
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    const w = Math.abs(a[0] - b[0]);
    const h = Math.abs(a[1] - b[1]);
    return { x, y, w, h };
}

/** Draw one annotation into a 2D context. `scale` converts natural → target px. */
function drawAnnotation(
    ctx: CanvasRenderingContext2D,
    a: Annotation,
    scale: number,
): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = a.width * scale;
    ctx.strokeStyle = a.color;
    if (a.tool === 'highlight') {
        ctx.globalAlpha = 0.35;
    }
    const pts = a.pts.map(([x, y]) => [x * scale, y * scale] as Pt);

    if (a.tool === 'pen' || a.tool === 'highlight') {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
    } else if (a.tool === 'rect') {
        const [p0, p1] = pts;
        ctx.strokeRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
    } else if (a.tool === 'arrow') {
        const [p0, p1] = pts;
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.stroke();
        const angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const head = Math.max(10, a.width * 4) * scale;
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p1[0] - head * Math.cos(angle - Math.PI / 7), p1[1] - head * Math.sin(angle - Math.PI / 7));
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p1[0] - head * Math.cos(angle + Math.PI / 7), p1[1] - head * Math.sin(angle + Math.PI / 7));
        ctx.stroke();
    }
    ctx.restore();
}

/** Render the base image + all annotations + optional crop overlay onto a canvas. */
function renderTo(
    canvas: HTMLCanvasElement,
    base: Source,
    annotations: Annotation[],
    crop: Rect | null,
    targetW: number,
    targetH: number,
    scale: number,
    dpr: number,
    withCropOverlay: boolean,
): void {
    canvas.width = Math.round(targetW * dpr);
    canvas.height = Math.round(targetH * dpr);
    canvas.style.width = `${targetW}px`;
    canvas.style.height = `${targetH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.drawImage(base as CanvasImageSource, 0, 0, targetW, targetH);
    for (const a of annotations) drawAnnotation(ctx, a, scale);

    if (withCropOverlay && crop) {
        const cx = crop.x * scale;
        const cy = crop.y * scale;
        const cw = crop.w * scale;
        const ch = crop.h * scale;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        // four dimmed rectangles around the selection
        ctx.fillRect(0, 0, targetW, cy); // top
        ctx.fillRect(0, cy + ch, targetW, targetH - (cy + ch)); // bottom
        ctx.fillRect(0, cy, cx, ch); // left
        ctx.fillRect(cx + cw, cy, targetW - (cx + cw), ch); // right
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx, cy, cw, ch);
    }
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

function downscaleCanvas(src: HTMLCanvasElement, maxWidth: number): HTMLCanvasElement {
    if (src.width <= maxWidth) return src;
    const ratio = maxWidth / src.width;
    const out = document.createElement('canvas');
    out.width = maxWidth;
    out.height = Math.round(src.height * ratio);
    const ctx = out.getContext('2d');
    ctx?.drawImage(src, 0, 0, out.width, out.height);
    return out;
}

/** Produce a File from a natural-resolution canvas, trying WebP → JPEG → PNG and
 * downscaling if the result exceeds the 5 MiB backend limit. */
async function canvasToFile(canvas: HTMLCanvasElement): Promise<File> {
    const candidates: Array<[string, number]> = [
        ['image/webp', 0.85],
        ['image/jpeg', 0.85],
        ['image/png', 1],
    ];
    let blob: Blob | null = null;
    let usedType = 'image/png';
    for (const [type, quality] of candidates) {
        // eslint-disable-next-line no-await-in-loop
        blob = await canvasToBlob(canvas, type, quality);
        if (blob) {
            usedType = type;
            break;
        }
    }
    if (blob && blob.size > MAX_OUTPUT_BYTES) {
        const scaled = downscaleCanvas(canvas, MAX_OUTPUT_WIDTH);
        for (const [type, quality] of candidates) {
            // eslint-disable-next-line no-await-in-loop
            const b = await canvasToBlob(scaled, type, quality);
            if (b) {
                blob = b;
                usedType = type;
                break;
            }
        }
    }
    blob = blob ?? new Blob();
    const ext = usedType === 'image/webp' ? 'webp' : usedType === 'image/jpeg' ? 'jpg' : 'png';
    return new File([blob], `screenshot.${ext}`, { type: usedType });
}

export function ScreenshotEditor({ source, onConfirm, onCancel, onRetake, t }: ScreenshotEditorProps) {
    const [baseImage, setBaseImage] = useState<Source>(source);
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    const [tool, setTool] = useState<Tool>('pen');
    const [color, setColor] = useState(COLORS[0]);
    const [crop, setCrop] = useState<Rect | null>(null);
    const [busy, setBusy] = useState(false);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    // In-progress drag: a crop drag or a draft annotation (not yet committed).
    const draftRef = useRef<{ start: Pt; cur: Pt } | null>(null);
    // Latest values for the imperative pointer handlers (avoid stale closures).
    const liveRef = useRef({ baseImage, annotations, tool, color, crop });
    liveRef.current = { baseImage, annotations, tool, color, crop };

    const natural = sourceSize(baseImage);
    const dispW = Math.min(MAX_DISPLAY_WIDTH, natural.w, Math.max(220, window.innerWidth - 96));
    const scale = natural.w / dispW; // natural px per display px
    const dispH = natural.h / scale;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    const redraw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { baseImage: base, annotations: anns, crop: cr } = liveRef.current;
        renderTo(canvas, base, anns, cr, dispW, dispH, 1 / scale, dpr, true);
        // draw the in-progress draft on top
        const draft = draftRef.current;
        if (!draft) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const s = 1 / scale;
        const startN: Pt = [draft.start[0] * s, draft.start[1] * s];
        const curN: Pt = [draft.cur[0] * s, draft.cur[1] * s];
        const { tool: tl, color: col } = liveRef.current;
        if (tl === 'crop') {
            const r = normalizeRect(startN, curN);
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.fillRect(0, 0, dispW, r.y);
            ctx.fillRect(0, r.y + r.h, dispW, dispH - (r.y + r.h));
            ctx.fillRect(0, r.y, r.x, r.h);
            ctx.fillRect(r.x + r.w, r.y, dispW - (r.x + r.w), r.h);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(r.x, r.y, r.w, r.h);
        } else {
            const a: Annotation = {
                tool: tl as Annotation['tool'],
                color: col,
                width: tl === 'highlight' ? HIGHLIGHT_WIDTH : PEN_WIDTH,
                pts: tl === 'pen' || tl === 'highlight' ? [startN, curN] : [startN, curN],
            };
            drawAnnotation(ctx, a, 1);
        }
    }, [dispW, dispH, scale, dpr]);

    // Redraw on every state change.
    useEffect(() => {
        redraw();
    }, [redraw, baseImage, annotations, crop]);

    // Redraw on viewport resize.
    useEffect(() => {
        function onResize() {
            redraw();
        }
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [redraw]);

    function toNatural(e: React.PointerEvent<HTMLCanvasElement>): Pt {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        const cssY = e.clientY - rect.top;
        return [cssX * scale, cssY * scale];
    }

    function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
        if (busy) return;
        e.preventDefault();
        canvasRef.current?.setPointerCapture(e.pointerId);
        const p = toNatural(e);
        draftRef.current = { start: p, cur: p };
        redraw();
    }

    function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
        const draft = draftRef.current;
        if (!draft) return;
        e.preventDefault();
        draft.cur = toNatural(e);
        redraw();
    }

    function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
        const draft = draftRef.current;
        if (!draft) return;
        e.preventDefault();
        canvasRef.current?.releasePointerCapture(e.pointerId);
        draft.cur = toNatural(e);
        draftRef.current = null;
        const { tool: tl, color: col } = liveRef.current;
        const start = draft.start;
        const end = draft.cur;
        const moved = Math.abs(start[0] - end[0]) > 2 || Math.abs(start[1] - end[1]) > 2;
        if (tl === 'crop') {
            setCrop(moved ? normalizeRect(start, end) : null);
        } else if (moved) {
            const a: Annotation = {
                tool: tl as Annotation['tool'],
                color: col,
                width: tl === 'highlight' ? HIGHLIGHT_WIDTH : PEN_WIDTH,
                pts: [start, end],
            };
            setAnnotations((prev) => [...prev, a]);
        }
    }

    function applyCrop() {
        if (!crop || crop.w < 4 || crop.h < 4) return;
        const out = document.createElement('canvas');
        out.width = Math.round(crop.w);
        out.height = Math.round(crop.h);
        const ctx = out.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(
            baseImage as CanvasImageSource,
            crop.x,
            crop.y,
            crop.w,
            crop.h,
            0,
            0,
            out.width,
            out.height,
        );
        setBaseImage(out);
        setAnnotations([]);
        setCrop(null);
    }

    async function confirm() {
        setBusy(true);
        try {
            // Render at natural resolution (no crop overlay).
            const out = document.createElement('canvas');
            const n = sourceSize(baseImage);
            renderTo(out, baseImage, annotations, null, n.w, n.h, 1, 1, false);
            const file = await canvasToFile(out);
            onConfirm(file);
        } finally {
            setBusy(false);
        }
    }

    const tools: Array<{ tool: Tool; icon: Parameters<typeof Icon>[0]['name']; label: string }> = [
        { tool: 'pen', icon: 'pen', label: t.toolPen },
        { tool: 'arrow', icon: 'arrow', label: t.toolArrow },
        { tool: 'rect', icon: 'rect', label: t.toolRect },
        { tool: 'highlight', icon: 'highlight', label: t.toolHighlight },
        { tool: 'crop', icon: 'crop', label: t.toolCrop },
    ];

    return (
        <div className="screenshot-editor">
            <h2>{t.editorTitle}</h2>
            <p className="modal__subtitle">{t.editorHint}</p>

            <div className="screenshot-editor__toolbar" role="group" aria-label={t.editorTitle}>
                {tools.map(({ tool: tl, icon, label }) => (
                    <button
                        key={tl}
                        type="button"
                        className="icon-button screenshot-editor__tool"
                        aria-pressed={tool === tl}
                        title={label}
                        onClick={() => {
                            setTool(tl);
                            setCrop(null);
                        }}
                        disabled={busy}
                    >
                        <Icon name={icon} />
                    </button>
                ))}
                <span className="screenshot-editor__sep" aria-hidden="true" />
                {COLORS.map((c) => (
                    <button
                        key={c}
                        type="button"
                        className="screenshot-editor__swatch"
                        aria-pressed={color === c}
                        aria-label={t.colorLabel}
                        style={{ backgroundColor: c }}
                        onClick={() => setColor(c)}
                        disabled={busy}
                    />
                ))}
                <span className="screenshot-editor__sep" aria-hidden="true" />
                <button
                    type="button"
                    className="icon-button"
                    onClick={() => setAnnotations((prev) => prev.slice(0, -1))}
                    disabled={busy || annotations.length === 0}
                    title={t.undo}
                >
                    <Icon name="undo" />
                </button>
                <button
                    type="button"
                    onClick={() => {
                        setAnnotations([]);
                        setCrop(null);
                    }}
                    disabled={busy || (annotations.length === 0 && !crop)}
                >
                    {t.clear}
                </button>
            </div>

            <div className="screenshot-editor__hint">
                {tool === 'crop' ? t.cropHint : t.annotateHint}
                {tool === 'crop' && crop && crop.w >= 4 && crop.h >= 4 && (
                    <button type="button" className="screenshot-editor__apply" onClick={applyCrop} disabled={busy}>
                        {t.applyCrop}
                    </button>
                )}
            </div>

            <div className="screenshot-editor__canvas">
                <canvas
                    ref={canvasRef}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    style={{ touchAction: 'none' }}
                />
            </div>

            <div className="report-form__actions screenshot-editor__actions">
                <button type="button" onClick={onCancel} disabled={busy}>
                    {t.cancelEdit}
                </button>
                <button type="button" onClick={onRetake} disabled={busy}>
                    {t.retake}
                </button>
                <button type="button" className="primary" onClick={confirm} disabled={busy}>
                    {busy ? t.sending : t.confirm}
                </button>
            </div>
        </div>
    );
}