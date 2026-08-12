import { useEffect, useState } from 'react';
import { Icon } from './icons';

/**
 * Debounced search box.
 *
 * The input keeps its own state so typing stays responsive, and only publishes
 * upward after a pause — otherwise every keystroke would be a request and a
 * history entry.
 */
export function SearchInput({
    value,
    onChange,
    label,
    delay = 250,
}: {
    value: string;
    onChange: (next: string) => void;
    label: string;
    delay?: number;
}) {
    const [draft, setDraft] = useState(value);

    // Re-sync when the URL changes from outside — back button, a new entity type.
    useEffect(() => {
        setDraft(value);
    }, [value]);

    useEffect(() => {
        if (draft === value) return;
        const timer = setTimeout(() => onChange(draft), delay);
        return () => clearTimeout(timer);
    }, [draft, value, delay, onChange]);

    return (
        <div className="search-input">
            <label className="visually-hidden" htmlFor="list-search">
                {label}
            </label>
            <Icon name="search" className="search-input__icon" />
            <input
                id="list-search"
                type="search"
                value={draft}
                placeholder={label}
                onChange={(event) => setDraft(event.target.value)}
            />
        </div>
    );
}
