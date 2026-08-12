import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { DataTable, type Column } from './DataTable';
import { renderWithProviders } from '../test/renderWithProviders';
import { setViewportWidth } from '../test/media';

interface Row {
    id: string;
    name: string;
    role: string;
}

const ROWS: Row[] = [
    { id: 'ab12c', name: 'Helena', role: 'Innkeeper' },
    { id: 'de34f', name: 'Corvo', role: 'Fence' },
];

const COLUMNS: Array<Column<Row>> = [
    { key: 'name', label: 'Name', render: (row) => row.name },
    { key: 'role', label: 'Role', render: (row) => row.role },
];

function render(width: number) {
    setViewportWidth(width);
    return renderWithProviders(
        <DataTable
            columns={COLUMNS}
            rows={ROWS}
            rowKey={(row) => row.id}
            href={(row) => `/npcs/${row.id}`}
        />,
    );
}

afterEach(() => setViewportWidth(0));

describe('DataTable', () => {
    it('links the first cell instead of handling a row click', () => {
        render(1024);

        // A row onClick cannot be opened in a new tab, copied, or tabbed to.
        expect(screen.getByRole('link', { name: 'Helena' })).toHaveAttribute('href', '/npcs/ab12c');
        expect(screen.getByRole('link', { name: 'Corvo' })).toHaveAttribute('href', '/npcs/de34f');
    });

    it('renders a real table above the 640px breakpoint', () => {
        render(1024);

        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Role' })).toBeInTheDocument();
    });

    it('switches to cards below it, rather than scrolling prose sideways', () => {
        render(375);

        expect(screen.queryByRole('table')).toBeNull();
        // The header becomes a per-card label, so the data stays self-describing.
        expect(screen.getAllByText('Role')).toHaveLength(2);
        expect(screen.getByRole('link', { name: 'Helena' })).toBeInTheDocument();
    });

    it('disables protected rows and excludes them from select-all', () => {
        setViewportWidth(1024);
        const onToggleSelectAll = vi.fn();

        renderWithProviders(
            <DataTable
                columns={COLUMNS}
                rows={ROWS}
                rowKey={(row) => row.id}
                selected={new Set()}
                onToggleSelect={vi.fn()}
                onToggleSelectAll={onToggleSelectAll}
                isRowSelectable={(row) => row.id !== 'ab12c'}
                selectLabel={(row) => `Select ${row.name}`}
                selectAllLabel="Select all"
            />,
        );

        expect(screen.getByRole('checkbox', { name: 'Select Helena' })).toBeDisabled();
        expect(screen.getByRole('checkbox', { name: 'Select Corvo' })).toBeEnabled();

        screen.getByRole('checkbox', { name: 'Select all' }).click();
        expect(onToggleSelectAll).toHaveBeenCalledWith(['de34f'], true);
    });
});
