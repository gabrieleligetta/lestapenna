import type { Alignment } from '../api/types';
import { useT } from '../i18n';

export type MoralAlignment = 'GOOD' | 'NEUTRAL' | 'EVIL';
export type EthicalAlignment = 'LAWFUL' | 'NEUTRAL' | 'CHAOTIC';

/**
 * The two axes together — the only way alignment is ever shown.
 *
 * A bar on its own means nothing: moral without ethical is half an answer. The
 * pair was written out identically in the NPC/character views, the faction view
 * and the party page, each with its own casts; here it takes the API's
 * `Alignment` and needs none.
 *
 * The heading stays with the caller: the party page calls it "group alignment"
 * and a faction calls it "alignment", and that difference is meaningful.
 */
export function AlignmentPair({ alignment }: { alignment: Alignment }) {
    return (
        <>
            <AlignmentBar axis="moral" score={alignment.moral.score} label={alignment.moral.label} />
            <AlignmentBar axis="ethical" score={alignment.ethical.score} label={alignment.ethical.label} />
        </>
    );
}

interface Props {
    axis: 'moral' | 'ethical';
    /** -100..100. Clamped here; the API clamps too, but a stale row should not overflow the track. */
    score: number;
    /**
     * The enum the API assigned to this score. Rendered as-is, never re-derived:
     * the ±25 thresholds live in src/utils/alignmentUtils.ts on the server, and a
     * second copy here would drift the moment they are tuned.
     */
    label: MoralAlignment | EthicalAlignment | null;
}

/** Which pole a score sits on, for colour only — the text always comes from `label`. */
function polarity(score: number): 'neg' | 'neutral' | 'pos' {
    if (score > 0) return 'pos';
    if (score < 0) return 'neg';
    return 'neutral';
}

export function AlignmentBar({ axis, score, label }: Props) {
    const t = useT();
    const clamped = Math.max(-100, Math.min(100, score));

    // The track runs -100..100 with zero at the centre; the fill spans centre to score.
    const centre = 50;
    const half = clamped / 2;
    const left = clamped >= 0 ? centre : centre + half;
    const width = Math.abs(half);

    const axisName = axis === 'moral' ? t.align.moral : t.align.ethical;
    const poles =
        axis === 'moral'
            ? { neg: t.align.axis.EVIL, pos: t.align.axis.GOOD }
            : { neg: t.align.axis.CHAOTIC, pos: t.align.axis.LAWFUL };
    const text = label ? t.align.axis[label] : t.align.axis.NEUTRAL;

    return (
        <div className="alignment-bar">
            <div className="alignment-head">
                <span className="label">{axisName}</span>
                <span className="alignment-value">
                    {text} <span className="alignment-score">{clamped > 0 ? `+${clamped}` : clamped}</span>
                </span>
            </div>
            <div
                className="alignment-track"
                role="meter"
                aria-label={axisName}
                aria-valuemin={-100}
                aria-valuemax={100}
                aria-valuenow={clamped}
                aria-valuetext={`${text} (${clamped})`}
            >
                <span className="alignment-centre" aria-hidden="true" />
                <span
                    className={`alignment-fill alignment-fill-${polarity(clamped)}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                />
            </div>
            <div className="alignment-poles" aria-hidden="true">
                <span>{poles.neg}</span>
                <span>{poles.pos}</span>
            </div>
        </div>
    );
}
