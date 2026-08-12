import { useT } from '../i18n';

function signed(value: number): string {
    return value > 0 ? `+${value}` : String(value);
}

/**
 * How far a single event moved the entity's alignment.
 *
 * The alignment is the average of the non-zero weights in the history: without
 * this badge the bar on the card cannot be traced back to anything visible. A
 * zero weight on both axes produces no badge — colouring "no effect" on every
 * row would make precisely the events that matter unreadable.
 */
export function AlignmentDelta({
    moral,
    ethical,
}: {
    moral: number | null | undefined;
    ethical: number | null | undefined;
}) {
    const t = useT();
    const moralValue = moral ?? 0;
    const ethicalValue = ethical ?? 0;
    if (moralValue === 0 && ethicalValue === 0) return null;

    const axes = [
        { key: 'moral', short: t.events.moralShort, label: t.align.moral, value: moralValue },
        { key: 'ethical', short: t.events.ethicalShort, label: t.align.ethical, value: ethicalValue },
    ].filter((axis) => axis.value !== 0);

    return (
        <span className="alignment-delta">
            <span className="alignment-delta__label">{t.events.alignmentImpact}</span>
            {axes.map((axis) => (
                <span
                    key={axis.key}
                    className={`alignment-delta__axis alignment-delta__axis--${axis.value > 0 ? 'up' : 'down'}`}
                    title={`${axis.label}: ${signed(axis.value)}`}
                >
                    <span aria-hidden="true">{axis.short}</span>
                    <span className="visually-hidden">{axis.label}</span>
                    {' '}
                    {signed(axis.value)}
                </span>
            ))}
        </span>
    );
}
