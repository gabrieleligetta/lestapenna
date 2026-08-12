import { useT } from '../i18n';
import type { EthicalAlignment, MoralAlignment } from './AlignmentBar';

interface Props {
    moral: MoralAlignment | null;
    ethical: EthicalAlignment | null;
}

/**
 * The nine-cell alignment as one phrase, for table rows where a pair of bars
 * would not fit. Uses the same wording as the bot's `$npc`/`$faction` embeds.
 */
export function AlignmentCell({ moral, ethical }: Props) {
    const t = useT();
    if (!moral && !ethical) return <span className="muted">—</span>;

    const key = `${ethical ?? 'NEUTRAL'}_${moral ?? 'NEUTRAL'}` as keyof typeof t.align.pairs;
    const label = t.align.pairs[key] ?? `${ethical ?? ''} ${moral ?? ''}`.trim();
    const tone = moral === 'GOOD' ? 'pos' : moral === 'EVIL' ? 'neg' : 'neutral';

    return (
        <span className="alignment-cell">
            <span className={`alignment-dot alignment-fill-${tone}`} aria-hidden="true" />
            {label}
        </span>
    );
}
