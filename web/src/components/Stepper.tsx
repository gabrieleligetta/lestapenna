/**
 * Where you are in a sequence of steps.
 *
 * Extracted from the merge dialog, which was the only multi-step flow in the
 * app and drew its own: the markup and the classes were already right, the CSS
 * simply hardcoded three columns. It now takes as many as it is given.
 *
 * `current` is an index rather than a mode string so a caller with five steps
 * does not have to spell out a comparison per step to work out what is behind
 * it and what is ahead.
 */
export function Stepper({
    steps, current, label,
}: {
    steps: string[];
    /** Zero-based. Everything before it counts as done. */
    current: number;
    /** Accessible name of the list itself. */
    label: string;
}) {
    return (
        <ol
            className="merge-steps"
            aria-label={label}
            style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}
        >
            {steps.map((step, index) => (
                <li
                    key={step}
                    className={[
                        'merge-steps__item',
                        index === current ? 'is-active' : '',
                        index < current ? 'is-complete' : '',
                    ].filter(Boolean).join(' ')}
                    aria-current={index === current ? 'step' : undefined}
                >
                    <span>{index + 1}</span>
                    {step}
                </li>
            ))}
        </ol>
    );
}
