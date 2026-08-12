import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons';

export function AiCostIndicator({
    label,
    description,
}: {
    label: string;
    description: string;
}) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const rootRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (!open) return;
        function onPointerDown(event: PointerEvent) {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        }
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') setOpen(false);
        }
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    return (
        <span
            ref={rootRef}
            className="ai-cost-indicator"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <button
                type="button"
                className="ai-cost-indicator__button"
                aria-label={label}
                aria-describedby={id}
                aria-expanded={open}
                onClick={() => setOpen(true)}
            >
                <Icon name="coins" />
            </button>
            <span
                id={id}
                role="tooltip"
                className="ai-cost-indicator__tooltip"
                hidden={!open}
            >
                {description}
            </span>
        </span>
    );
}
