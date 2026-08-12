import type { ReactNode } from 'react';

export interface Field {
    key: string;
    label: string;
    value: ReactNode;
    /** Long-form copy needs the full measure instead of a narrow metadata value column. */
    layout?: 'metadata' | 'prose';
}

/**
 * A labelled description list.
 *
 * Takes an explicit field spec rather than iterating Object.entries: the old
 * detail view printed the DB column name as the label ('macro_location',
 * 'rag_sync_needed'), which is how internal plumbing ended up on screen.
 *
 * Empty values are dropped here, so callers do not each repeat the check.
 */
export function FieldList({ fields }: { fields: Field[] }) {
    const shown = fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== '');
    if (shown.length === 0) return null;

    return (
        <dl className="field-list">
            {shown.map((field) => (
                <div key={field.key} className={field.layout === 'prose' ? 'field-list__row field-list__row--prose' : 'field-list__row'}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                </div>
            ))}
        </dl>
    );
}
