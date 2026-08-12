import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeDuplicatesModal } from './MergeDuplicatesModal';
import { renderWithProviders } from '../test/renderWithProviders';
import { http, HttpResponse, server } from '../test/server';
import type { DuplicateMember, MergePreview, MergeResult } from '../api/types';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CAMPAIGN = 'c1';
const GUILD = 'g1';

const MEMBERS: DuplicateMember[] = [
    { short_id: 'abc', name: 'Corona di spine', is_manual: 0, history_count: 6, has_rag: true, description: 'Bio A', score: 0, reason: 'manual_selection' },
    { short_id: 'def', name: 'Corona di Spine', is_manual: 0, history_count: 5, has_rag: true, description: 'Bio B', score: 0, reason: 'manual_selection' },
];

const PREVIEW: MergePreview = {
    survivor_short_id: 'abc',
    survivor_name: 'Corona di spine',
    final_name: 'Corona di spine',
    record: [
        { field: 'effects', survivor_value: 'Connessione psichica', drop_short_id: 'def', drop_name: 'Corona di Spine', drop_value: 'Immagazzinato', verdict: 'differs' },
    ],
    events: [
        { drop_short_id: 'def', drop_name: 'Corona di Spine', event_type: 'OBSERVATION', session_date: null, description_preview: 'Osservato durante il rito' },
    ],
    relations: [],
    rag: [
        { drop_short_id: 'abc', drop_name: 'Corona di spine', fragment_id: 4837, header: '[[SCHEDA ARTEFATTO UFFICIALE: Corona di spine]]', version_count: 2, action: 'kept' },
        { drop_short_id: 'def', drop_name: 'Corona di Spine', fragment_id: 5007, header: '[[SCHEDA ARTEFATTO UFFICIALE: Corona di Spine]]', version_count: 8, action: 'consolidated' },
    ],
};

const MERGE_RESULT: MergeResult = {
    survivor_short_id: 'abc',
    survivor_name: 'Corona di spine',
    report: {
        merged_rows: [{ short_id: 'def', name: 'Corona di Spine' }],
        history_repointed: 5,
        rag_fragments_deleted: 1,
        rag_refs_rewritten: 0,
        relations_repointed: 0,
        short_id_regenerated: false,
        manual_propagated: false,
    },
};

function renderModal(selectedShortIds: string[]) {
    return renderWithProviders(
        <MergeDuplicatesModal
            open
            onClose={() => {}}
            campaignId={CAMPAIGN}
            guildId={GUILD}
            entityType="artifacts"
            selectedShortIds={selectedShortIds}
        />,
        { locale: 'en' },
    );
}

function membersUrl() {
    return `/api/v1/campaigns/${CAMPAIGN}/merge/artifacts/members`;
}
function previewUrl() {
    return `/api/v1/campaigns/${CAMPAIGN}/merge/artifacts/preview`;
}
function mergeUrl() {
    return `/api/v1/campaigns/${CAMPAIGN}/merge/artifacts`;
}

describe('MergeDuplicatesModal (selection-driven)', () => {
    it('loads selected members + shows survivor/dies labels', async () => {
        server.use(http.post(membersUrl(), () => HttpResponse.json(MEMBERS)));
        renderModal(['abc', 'def']);

        expect(await screen.findByText('Corona di spine')).toBeInTheDocument();
        expect(screen.getByText('Corona di Spine')).toBeInTheDocument();
        // default survivor = most history (6 > 5) → "Survives"; other → "Will be merged"
        expect(screen.getAllByText(/Survives/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Will be merged/i).length).toBeGreaterThan(0);
    });

    it('merges end-to-end (review → confirm diff → success)', async () => {
        const user = userEvent.setup();
        let mergeCalls = 0;
        server.use(
            http.post(membersUrl(), () => HttpResponse.json(MEMBERS)),
            http.post(previewUrl(), () => HttpResponse.json(PREVIEW)),
            http.post(mergeUrl(), async () => {
                mergeCalls += 1;
                return HttpResponse.json(MERGE_RESULT);
            }),
        );
        renderModal(['abc', 'def']);

        // click "Verify merge →" to enter confirm
        const verifyBtn = await screen.findByRole('button', { name: /Verify merge/i });
        await user.click(verifyBtn);

        // confirm step shows the diff sections
        expect(await screen.findByText(/records below will be merged/i)).toBeInTheDocument();
        expect(screen.getByText(/Record fields/i)).toBeInTheDocument();
        expect(screen.getByText(/History events/i)).toBeInTheDocument();
        expect(screen.getByText(/RAG memory/i)).toBeInTheDocument();

        const confirmBtn = await screen.findByRole('button', { name: /Merge permanently/i });
        expect(mergeCalls).toBe(0);
        await user.click(confirmBtn);

        await waitFor(() => expect(screen.getByText(/Records merged into/i)).toBeInTheDocument());
        expect(mergeCalls).toBe(1);
        expect(screen.getByText(/1 record merged and deleted/i)).toBeInTheDocument();
        expect(screen.getByText(/1 RAG snapshot version preserved in the chronological timeline/i)).toBeInTheDocument();
    });

    it('keeps a successful merge successful when the following refresh fails', async () => {
        const user = userEvent.setup();
        server.use(
            http.post(membersUrl(), () => HttpResponse.json(MEMBERS)),
            http.post(previewUrl(), () => HttpResponse.json(PREVIEW)),
            http.post(mergeUrl(), () => HttpResponse.json(MERGE_RESULT)),
        );
        const { queryClient } = renderModal(['abc', 'def']);
        vi.spyOn(queryClient, 'invalidateQueries').mockRejectedValue(new Error('refresh unavailable'));

        await user.click(await screen.findByRole('button', { name: /Verify merge/i }));
        await user.click(await screen.findByRole('button', { name: /Merge permanently/i }));

        expect(await screen.findByText(/Records merged into/i)).toBeInTheDocument();
        expect(screen.queryByText(/refresh unavailable/i)).not.toBeInTheDocument();
    });

    it('shows the empty state when fewer than 2 were selected', async () => {
        server.use(http.post(membersUrl(), () => HttpResponse.json([MEMBERS[0]])));
        renderModal(['abc']);
        expect(await screen.findByText(/Select at least 2 entities/i)).toBeInTheDocument();
    });

    it('passes the description override to the read-only preview', async () => {
        const user = userEvent.setup();
        let body: Record<string, unknown> | null = null;
        server.use(
            http.post(membersUrl(), () => HttpResponse.json(MEMBERS)),
            http.post(previewUrl(), async ({ request }) => {
                body = await request.json() as Record<string, unknown>;
                return HttpResponse.json(PREVIEW);
            }),
        );
        renderModal(['abc', 'def']);

        await user.type(
            await screen.findByLabelText(/Survivor description/i),
            'Descrizione finale composta',
        );
        await user.click(screen.getByRole('button', { name: /Verify merge/i }));

        await waitFor(() => expect(body).not.toBeNull());
        expect((body as Record<string, unknown> | null)?.description).toBe('Descrizione finale composta');
    });

    it('shows faction relationships that will be preserved or consolidated', async () => {
        const user = userEvent.setup();
        server.use(
            http.post(membersUrl(), () => HttpResponse.json(MEMBERS)),
            http.post(previewUrl(), () => HttpResponse.json({
                ...PREVIEW,
                relations: [{
                    drop_short_id: 'def',
                    drop_name: 'Dame di Ferro',
                    relation_type: 'membership',
                    label: 'Astrid Foe · LEADER',
                    action: 'deduplicated',
                }],
            })),
        );
        renderModal(['abc', 'def']);

        await user.click(await screen.findByRole('button', { name: /Verify merge/i }));

        expect(await screen.findByText(/Linked relationships/i)).toBeInTheDocument();
        expect(screen.getByText(/Duplicate consolidated · Astrid Foe · LEADER/i)).toBeInTheDocument();
    });

    it('does not enable the destructive action when preview fails', async () => {
        const user = userEvent.setup();
        server.use(
            http.post(membersUrl(), () => HttpResponse.json(MEMBERS)),
            http.post(previewUrl(), () => HttpResponse.json({ message: 'preview unavailable' }, { status: 500 })),
        );
        renderModal(['abc', 'def']);

        await user.click(await screen.findByRole('button', { name: /Verify merge/i }));
        await screen.findByRole('button', { name: /Retry/i });
        expect(screen.getByRole('button', { name: /Merge permanently/i })).toBeDisabled();
    });

    it('uses the newly picked survivor name until the final name is edited', async () => {
        const user = userEvent.setup();
        server.use(http.post(membersUrl(), () => HttpResponse.json(MEMBERS)));
        renderModal(['abc', 'def']);

        const radios = await screen.findAllByRole('radio');
        await user.click(radios[1]);
        expect(screen.getByRole('combobox', { name: /Final name/i })).toHaveValue('Corona di Spine');
    });
});
