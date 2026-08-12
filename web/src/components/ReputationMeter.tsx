import { useT } from '../i18n';

export type ReputationLevel =
    | 'HOSTILE'
    | 'DISTRUSTFUL'
    | 'COLD'
    | 'NEUTRAL'
    | 'CORDIAL'
    | 'FRIENDLY'
    | 'ALLIED';

/** Centre outwards in both directions — the order the ramp tokens are declared in. */
const TIERS: ReputationLevel[] = [
    'HOSTILE',
    'DISTRUSTFUL',
    'COLD',
    'NEUTRAL',
    'CORDIAL',
    'FRIENDLY',
    'ALLIED',
];

interface Props {
    level: ReputationLevel;
    /** -100..100, when the caller has the raw score as well as the tier. */
    score?: number | null;
}

/**
 * Seven discrete tiers. Unlike the alignment bar there is no length to read, so
 * colour carries the value here — which is why the tier name is always printed
 * beside it: the midpoint sits below 3:1 against the surface by design, and a
 * sub-3:1 mark may never be the only carrier of meaning.
 */
export function ReputationMeter({ level, score }: Props) {
    const t = useT();
    const activeIndex = TIERS.indexOf(level);

    return (
        <div className="reputation">
            <div className="reputation-track" role="img" aria-label={`${t.reputation.label}: ${t.reputation.levels[level]}`}>
                {TIERS.map((tier, i) => (
                    <span
                        key={tier}
                        className={`reputation-step reputation-${tier.toLowerCase()}${i === activeIndex ? ' is-active' : ''}`}
                    />
                ))}
            </div>
            <span className="reputation-label">
                {t.reputation.levels[level]}
                {score !== null && score !== undefined && (
                    <span className="alignment-score"> {score > 0 ? `+${score}` : score}</span>
                )}
            </span>
        </div>
    );
}
