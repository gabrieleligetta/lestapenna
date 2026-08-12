import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { MEDIA } from '../breakpoints';

export interface Column<T> {
    key: string;
    label: string;
    render?: (row: T) => ReactNode;
    /** The sort key to send to the API. Omitted means the column is not sortable. */
    sortKey?: string;
}

export interface SortState {
    key: string;
    direction: 'asc' | 'desc';
    onSort: (key: string) => void;
}

interface Props<T> {
    columns: Array<Column<T>>;
    rows: T[];
    /** Row key, and the detail URL when `href` is given. */
    rowKey: (row: T) => string;
    href?: (row: T) => string;
    caption?: string;
    sort?: SortState;
    /** Optional row selection (e.g. merge flow): when `onToggleSelect` is provided,
     *  a leading checkbox is rendered per row. `selected` is the set of selected row keys. */
    selected?: Set<string>;
    onToggleSelect?: (key: string) => void;
    onToggleSelectAll?: (keys: string[], selected: boolean) => void;
    isRowSelectable?: (row: T) => boolean;
    selectLabel?: string | ((row: T) => string);
    selectAllLabel?: string;
}

/**
 * One table, two shapes.
 *
 * Below 640px it renders as cards rather than a table with horizontal scroll:
 * the columns here are narrative (description, macro_location, title) and
 * sideways-scrolling prose is miserable to read. Above it, a real table inside
 * an overflow wrapper — the wrapper is what keeps a wide table from pushing the
 * whole page sideways.
 *
 * The first cell is a real <Link>, not a row onClick: a click handler cannot be
 * opened in a new tab, copied, or reached by keyboard.
 */
export function DataTable<T>({
    columns,
    rows,
    rowKey,
    href,
    caption,
    sort,
    selected,
    onToggleSelect,
    onToggleSelectAll,
    isRowSelectable,
    selectLabel,
    selectAllLabel,
}: Props<T>) {
    const isWide = useMediaQuery(MEDIA.sm);
    const selectable = !!onToggleSelect;
    const selectableKeys = rows
        .filter((row) => isRowSelectable?.(row) ?? true)
        .map(rowKey)
        .filter(Boolean);
    const allVisibleSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selected?.has(key));

    function cell(row: T, column: Column<T>): ReactNode {
        return column.render ? column.render(row) : null;
    }

    function checkbox(row: T, key: string) {
        const enabled = isRowSelectable?.(row) ?? true;
        return (
            <input
                type="checkbox"
                className="row-select"
                checked={!!selected?.has(key)}
                disabled={!enabled}
                onChange={() => onToggleSelect?.(key)}
                onClick={(e) => e.stopPropagation()}
                aria-label={typeof selectLabel === 'function' ? selectLabel(row) : (selectLabel ?? key)}
            />
        );
    }

    if (!isWide) {
        return (
            <ul className="data-cards">
                {rows.map((row, rowIndex) => {
                    const [first, ...rest] = columns;
                    const title = cell(row, first);
                    const url = href?.(row);
                    const key = rowKey(row);
                    return (
                        <li
                            key={`${key}-${rowIndex}`}
                            className={`data-card${selected?.has(key) ? ' is-selected' : ''}`}
                        >
                            <div className="data-card-title">
                                {selectable && <span className="data-card-select">{checkbox(row, key)}</span>}
                                {url ? <Link to={url}>{title}</Link> : title}
                            </div>
                            <dl className="data-card-fields">
                                {rest.map((column) => (
                                    <div key={column.key}>
                                        <dt>{column.label}</dt>
                                        <dd>{cell(row, column)}</dd>
                                    </div>
                                ))}
                            </dl>
                        </li>
                    );
                })}
            </ul>
        );
    }

    return (
        <div className="table-scroll">
            <table className="entity-table">
                {caption && <caption className="visually-hidden">{caption}</caption>}
                <thead>
                    <tr>
                        {selectable && (
                            <th scope="col" className="th-select">
                                {onToggleSelectAll && (
                                    <input
                                        type="checkbox"
                                        className="row-select"
                                        checked={allVisibleSelected}
                                        onChange={() => onToggleSelectAll(selectableKeys, !allVisibleSelected)}
                                        aria-label={selectAllLabel}
                                    />
                                )}
                            </th>
                        )}
                        {columns.map((column) => {
                            const sortable = sort && column.sortKey;
                            const active = sortable && sort.key === column.sortKey;
                            return (
                                <th
                                    key={column.key}
                                    scope="col"
                                    // aria-sort is what tells a screen reader which column
                                    // orders the table, and in which direction.
                                    aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                                >
                                    {sortable ? (
                                        <button
                                            type="button"
                                            className="th-sort"
                                            onClick={() => sort.onSort(column.sortKey!)}
                                        >
                                            {column.label}
                                            <span aria-hidden="true">{active ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                                        </button>
                                    ) : (
                                        column.label
                                    )}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, rowIndex) => {
                        const url = href?.(row);
                        const key = rowKey(row);
                        return (
                            <tr key={`${key}-${rowIndex}`} className={selected?.has(key) ? 'is-selected' : undefined}>
                                {selectable && <td className="td-select">{checkbox(row, key)}</td>}
                                {columns.map((column, i) => (
                                    <td key={column.key}>
                                        {i === 0 && url ? <Link to={url}>{cell(row, column)}</Link> : cell(row, column)}
                                    </td>
                                ))}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
