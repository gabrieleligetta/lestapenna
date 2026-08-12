import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { useCallback, useState } from 'react';
import type {
    AiCredentialTestResult,
    AiPhaseOverride,
    AppInfo,
    AiProvider,
    CampaignAiSettings,
    CampaignEmbedding,
    ReindexEstimate,
    ReindexResult,
    GuildAiSettings,
    LegalDocumentName,
    LegalStatus,
    PricingOverride,
    ProviderModels,
    RemoteWhisperModels,
    PhaseModelCost,
    CampaignTranscription,
    SessionCostEstimate,
    TranscriptionPatch,
    TranscriptionProbe,
    TranscriptionSettings,
    WakeMethod,
    TierChoice,
    CampaignOverview,
    CampaignSummary,
    CrudEntityType,
    DuplicatesResult,
    EntityDeleteResult,
    EntityFragment,
    EntityRow,
    EntityType,
    EventMutation,
    EventedEntityType,
    FactionDetail,
    FactionMember,
    GuildSummary,
    HistoryEvent,
    Me,
    MergeableEntityType,
    MergePreview,
    MergeResult,
    DuplicateMember,
    Page,
    Party,
    QuestLifecycleSuggestion,
    SessionDetail,
    SessionSummary,
    SessionTranscript,
    AskAnswer,
    AskConversation,
    AskConversationDetail,
    AskEstimate,
    BioRegenEstimate,
    BioRegenResult,
    CampaignMember,
    CampaignSettings,
    CharacterSheet,
    CreateCampaignInput,
    EntityImage,
    EntityProfile,
    MediaEntityType,
    ReferenceCandidate,
    ReferenceImage,
    ReferenceScope,
} from './types';
import type { AiJob, MyAiJobs } from './types';
import { TERMINAL_AI_JOB_STATUSES } from './types';

export function useMe() {
    return useQuery({
        queryKey: ['me'],
        queryFn: () => apiFetch<Me>('/me'),
        retry: false, // a 401 means "not logged in", not a transient failure
    });
}

/**
 * The instance's own links and licence.
 *
 * Configuration, not data: it changes when someone edits an env var and
 * restarts, so re-fetching it on every window focus would be pure noise. It is
 * also the one query that must work logged out — the support bar sits on the
 * login page too.
 */
export function useAppInfo() {
    return useQuery({
        queryKey: ['app-info'],
        queryFn: () => apiFetch<AppInfo>('/app-info'),
        staleTime: Infinity,
        retry: false,
    });
}

export function useGuilds() {
    return useQuery({
        queryKey: ['me', 'guilds'],
        queryFn: () => apiFetch<GuildSummary[]>('/me/guilds'),
    });
}

export function useGuild(guildId: string) {
    return useQuery({
        queryKey: ['guilds', guildId],
        queryFn: () => apiFetch<GuildSummary>(`/guilds/${guildId}`),
        enabled: !!guildId,
    });
}

export function useGuildCampaigns(guildId: string) {
    return useQuery({
        queryKey: ['guilds', guildId, 'campaigns'],
        queryFn: () => apiFetch<CampaignSummary[]>(`/guilds/${guildId}/campaigns`),
        enabled: !!guildId,
    });
}

export function useCampaignOverview(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId],
        queryFn: () => apiFetch<CampaignOverview>(`/campaigns/${campaignId}`),
        enabled: !!campaignId,
    });
}

export function useCampaignPermissions(campaignId: string) {
    const { data, isLoading } = useCampaignOverview(campaignId);
    return {
        role: data?.myRole ?? null,
        canWrite: data?.canWrite ?? false,
        canManageMembers: data?.canManageMembers ?? false,
        isLoading,
    };
}

export function useParty(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'party'],
        queryFn: () => apiFetch<Party>(`/campaigns/${campaignId}/party`),
        enabled: !!campaignId,
    });
}

export function useFactionDetail(campaignId: string, shortId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'factions', shortId],
        queryFn: () => apiFetch<FactionDetail>(`/campaigns/${campaignId}/factions/${shortId}`),
        enabled: !!campaignId && !!shortId,
    });
}

export function useFactionMembers(campaignId: string, shortId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'factions', shortId, 'members'],
        queryFn: () => apiFetch<Page<FactionMember>>(`/campaigns/${campaignId}/factions/${shortId}/members?limit=100`),
        enabled: !!campaignId && !!shortId,
    });
}

export interface EntityListParams {
    limit?: number;
    offset?: number;
    status?: string; // quests only
    /** Public sort key from the API's whitelist; an unknown one falls back server-side. */
    sort?: string;
    dir?: 'asc' | 'desc';
    q?: string;
    category?: string; // inventory only
}

export function useCampaignEntityList(campaignId: string, entityType: EntityType, params: EntityListParams = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    if (params.status) query.set('status', params.status);
    if (params.sort) query.set('sort', params.sort);
    if (params.dir) query.set('dir', params.dir);
    if (params.q) query.set('q', params.q);
    if (params.category) query.set('category', params.category);
    const qs = query.toString();

    return useQuery({
        queryKey: ['campaigns', campaignId, entityType, params],
        queryFn: () => apiFetch<Page<EntityRow>>(`/campaigns/${campaignId}/${entityType}${qs ? `?${qs}` : ''}`),
        enabled: !!campaignId,
    });
}

/** `id` is a short_id for most types, a Discord user id for characters. Not valid for timeline/sessions (see useTimelineEventDetail/useSessionDetail). */
export function useEntityDetail<T = EntityRow>(campaignId: string, entityType: EventedEntityType, id: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, entityType, id],
        queryFn: () => apiFetch<T>(`/campaigns/${campaignId}/${entityType}/${id}`),
        enabled: !!campaignId && !!id,
    });
}

export function useQuestLifecycleSuggestions(campaignId: string, enabled = true) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'quests', 'lifecycle-suggestions'],
        queryFn: () =>
            apiFetch<QuestLifecycleSuggestion[]>(
                `/campaigns/${campaignId}/quests/lifecycle-suggestions?status=PENDING`,
            ),
        enabled: enabled && !!campaignId,
    });
}

export function useEntityEvents(campaignId: string, entityType: EventedEntityType, id: string, params: EntityListParams = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const qs = query.toString();

    return useQuery({
        queryKey: ['campaigns', campaignId, entityType, id, 'events', params],
        queryFn: () =>
            apiFetch<Page<HistoryEvent>>(`/campaigns/${campaignId}/${entityType}/${id}/events${qs ? `?${qs}` : ''}`),
        enabled: !!campaignId && !!id,
    });
}

/** Campaign-wide travel/visit log ($travels) — distinct from a single location's atlas events. */
export function useTravels(campaignId: string, limit = 25) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'travels', limit],
        queryFn: () => apiFetch<EntityRow[]>(`/campaigns/${campaignId}/travels?limit=${limit}`),
        enabled: !!campaignId,
    });
}

export function useTimelineEventDetail(campaignId: string, shortId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'timeline', shortId],
        queryFn: () => apiFetch<EntityRow>(`/campaigns/${campaignId}/timeline/${shortId}`),
        enabled: !!campaignId && !!shortId,
    });
}

export function useSessionDetail(campaignId: string, sessionId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'sessions', sessionId],
        queryFn: () => apiFetch<SessionDetail>(`/campaigns/${campaignId}/sessions/${sessionId}`),
        enabled: !!campaignId && !!sessionId,
    });
}

export function useCampaignSessions(campaignId: string, limit = 100, offset = 0) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'sessions', { limit, offset }],
        queryFn: () =>
            apiFetch<Page<SessionSummary>>(`/campaigns/${campaignId}/sessions?limit=${limit}&offset=${offset}`),
        enabled: !!campaignId,
    });
}

export function useSessionTranscript(campaignId: string, sessionId: string, enabled: boolean) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'sessions', sessionId, 'transcript'],
        queryFn: () => apiFetch<SessionTranscript>(`/campaigns/${campaignId}/sessions/${sessionId}/transcript`),
        enabled: enabled && !!campaignId && !!sessionId,
        gcTime: 0,
    });
}

/**
 * The memory fragments linked to an entity.
 *
 * `gcTime: 0` as for the session transcript: this is the raw text the Bardo
 * remembers, often long, and there is no point keeping it cached once the panel
 * has been closed.
 */
export function useEntityFragments(
    campaignId: string,
    entityType: CrudEntityType,
    id: string,
    enabled: boolean,
) {
    return useQuery({
        queryKey: ['campaigns', campaignId, entityType, id, 'fragments'],
        queryFn: () =>
            apiFetch<Page<EntityFragment>>(
                `/campaigns/${campaignId}/${entityType}/${id}/fragments?limit=100`,
            ),
        enabled: enabled && !!campaignId && !!id,
        gcTime: 0,
    });
}

/**
 * Writes to an entity: create, update, delete, plus corrections to the history
 * and pruning of the fragments.
 *
 * Follows the convention already used for merge — imperative apiFetch with
 * busy/error state and `invalidateQueries` afterwards, no useMutation — so
 * every mutation in the SPA behaves the same way.
 */
export function useEntityMutations(campaignId: string, entityType: CrudEntityType) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(
        () =>
            Promise.all([
                queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId], exact: true }),
                queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, entityType] }),
            ]).catch(() => undefined),
        [campaignId, entityType, queryClient],
    );

    const run = useCallback(
        async <T,>(path: string, method: string, body?: unknown): Promise<T | null> => {
            setBusy(true);
            setError(null);
            try {
                const result = await apiFetch<T>(`/campaigns/${campaignId}${path}`, {
                    method,
                    ...(body === undefined
                        ? {}
                        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
                });
                await refresh();
                return result;
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Request failed');
                return null;
            } finally {
                setBusy(false);
            }
        },
        [campaignId, refresh],
    );

    const createEntity = useCallback(
        (fields: Record<string, unknown>) =>
            run<EntityRow>(`/${entityType}`, 'POST', fields),
        [entityType, run],
    );

    const updateEntity = useCallback(
        (shortId: string, fields: Record<string, unknown>) =>
            run<EntityRow>(`/${entityType}/${encodeURIComponent(shortId)}`, 'PATCH', fields),
        [entityType, run],
    );

    const deleteEntity = useCallback(
        (shortId: string) =>
            run<EntityDeleteResult>(`/${entityType}/${encodeURIComponent(shortId)}`, 'DELETE'),
        [entityType, run],
    );

    const updateEvent = useCallback(
        (shortId: string, eventId: number, mutation: EventMutation) =>
            run<void>(`/${entityType}/${encodeURIComponent(shortId)}/events/${eventId}`, 'PATCH', mutation),
        [entityType, run],
    );

    const deleteEvent = useCallback(
        (shortId: string, eventId: number) =>
            run<void>(`/${entityType}/${encodeURIComponent(shortId)}/events/${eventId}`, 'DELETE'),
        [entityType, run],
    );

    const deleteFragment = useCallback(
        (shortId: string, fragmentId: number) =>
            run<void>(
                `/${entityType}/${encodeURIComponent(shortId)}/fragments/${fragmentId}`,
                'DELETE',
            ),
        [entityType, run],
    );

    return {
        busy,
        error,
        setError,
        createEntity,
        updateEntity,
        deleteEntity,
        updateEvent,
        deleteEvent,
        deleteFragment,
    };
}

// --- Merge duplicates ---

/** Detect duplicate clusters for a campaign + entity type. `semantic=1` enables
 *  embedding-based semantic dup detection (slower, reuses stored RAG vectors). */
export function useDuplicateClusters(campaignId: string, entityType: MergeableEntityType, semantic = false, enabled = true) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'merge', entityType, 'duplicates', { semantic }],
        queryFn: () =>
            apiFetch<DuplicatesResult>(
                `/campaigns/${campaignId}/merge/${entityType}/duplicates${semantic ? '?semantic=1' : ''}`,
            ),
        enabled: !!campaignId && enabled,
    });
}

/** Imperative merge (N→1). Follows the codebase convention: manual apiFetch in a
 *  handler with busy/error state, then invalidateQueries — no useMutation. */
export function useMergeDuplicates(campaignId: string, entityType: MergeableEntityType) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const merge = useCallback(
        async (args: {
            keepShortId: string;
            dropShortIds: string[];
            description?: string;
            autoMergeDescription?: boolean;
            confirmManualMerge?: boolean;
            finalName?: string;
        }): Promise<MergeResult | null> => {
            setBusy(true);
            setError(null);
            try {
                const result = await apiFetch<MergeResult>(
                    `/campaigns/${campaignId}/merge/${entityType}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            keep_short_id: args.keepShortId,
                            drop_short_ids: args.dropShortIds,
                            description: args.description,
                            auto_merge_description: args.autoMergeDescription,
                            confirm_manual_merge: args.confirmManualMerge,
                            final_name: args.finalName,
                        }),
                    },
                );
                // The mutation is already over by the time we get `result`: an error
                // during the refresh must not turn a successful merge into "failed".
                // We only invalidate overview + the family involved, in the background.
                void Promise.all([
                    queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId], exact: true }),
                    queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, entityType] }),
                ]).catch(() => undefined);
                return result;
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Merge failed');
                return null;
            } finally {
                setBusy(false);
            }
        },
        [campaignId, entityType, queryClient],
    );

    return { merge, busy, error };
}

/** Preview (read-only diff) of a merge: what survives / what is lost across record
 *  fields, history events, and RAG fragments, given a survivor + selected drops +
 *  optional final name. Used by the confirm step to show the consequences before
 *  the two-step confirm. */
export function useMergePreview(campaignId: string, entityType: MergeableEntityType) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<MergePreview | null>(null);

    const fetchPreview = useCallback(
        async (args: {
            keepShortId: string;
            dropShortIds: string[];
            finalName?: string;
            description?: string;
        }): Promise<void> => {
            setBusy(true);
            setError(null);
            try {
                const result = await apiFetch<MergePreview>(
                    `/campaigns/${campaignId}/merge/${entityType}/preview`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            keep_short_id: args.keepShortId,
                            drop_short_ids: args.dropShortIds,
                            final_name: args.finalName,
                            description: args.description,
                        }),
                    },
                );
                setPreview(result);
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Preview failed');
                setPreview(null);
            } finally {
                setBusy(false);
            }
        },
        [campaignId, entityType],
    );

    return { preview, busy, error, fetchPreview, setPreview };
}

/** Fetch member details (history, RAG, manual) for a set of entities the user
 *  selected manually from the list — no detection. Used by the merge modal when
 *  driven by explicit list selection. */
export function useMergeMembers(campaignId: string, entityType: MergeableEntityType) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [members, setMembers] = useState<DuplicateMember[] | null>(null);

    const fetchMembers = useCallback(
        async (shortIds: string[]): Promise<void> => {
            setBusy(true);
            setError(null);
            try {
                const result = await apiFetch<DuplicateMember[]>(
                    `/campaigns/${campaignId}/merge/${entityType}/members`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ short_ids: shortIds }),
                    },
                );
                setMembers(result);
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Failed to load members');
                setMembers(null);
            } finally {
                setBusy(false);
            }
        },
        [campaignId, entityType],
    );

    return { members, busy, error, fetchMembers, setMembers };
}

// --- Chat col Bardo ------------------------------------------------------

/**
 * Estimate for the exchange.
 *
 * Feeds the always-visible cost line above the composer: it is not a tooltip
 * detail, it is the price that has to be read before pressing "Ask".
 * `staleTime: 0` because the balance changes with every question.
 */
export function useAskEstimate(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ask', 'estimate'],
        queryFn: () => apiFetch<AskEstimate>(`/campaigns/${campaignId}/ask/estimate`),
        enabled: !!campaignId,
        staleTime: 0,
    });
}

export function useAskConversations(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ask', 'conversations'],
        queryFn: () => apiFetch<Page<AskConversation>>(`/campaigns/${campaignId}/ask/conversations?limit=100`),
        enabled: !!campaignId,
    });
}

export function useAskConversation(campaignId: string, conversationId: number | null) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ask', 'conversations', conversationId],
        queryFn: () => apiFetch<AskConversationDetail>(
            `/campaigns/${campaignId}/ask/conversations/${conversationId}`,
        ),
        enabled: !!campaignId && conversationId !== null,
    });
}

export function useAskActions(campaignId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const base = `/campaigns/${campaignId}/ask/conversations`;
    const invalidate = useCallback(
        (conversationId?: number) => Promise.all([
            queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'ask', 'conversations'] }),
            // The balance has changed: the cost line must say so right away.
            queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'ask', 'estimate'] }),
            conversationId === undefined
                ? Promise.resolve()
                : queryClient.invalidateQueries({
                    queryKey: ['campaigns', campaignId, 'ask', 'conversations', conversationId],
                }),
        ]),
        [campaignId, queryClient],
    );

    const run = useCallback(async <T,>(
        path: string,
        method: string,
        body?: unknown,
        conversationId?: number,
    ): Promise<T | null> => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<T>(path, {
                method,
                ...(body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }),
            });
            await invalidate(conversationId);
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [invalidate]);

    return {
        busy,
        error,
        setError,
        createConversation: () => run<AskConversation>(base, 'POST'),
        ask: (conversationId: number, question: string) =>
            run<AskAnswer>(`${base}/${conversationId}/messages`, 'POST', { question }, conversationId),
        rename: (conversationId: number, title: string) =>
            run<void>(`${base}/${conversationId}`, 'PATCH', { title }, conversationId),
        setShared: (conversationId: number, shared: boolean) =>
            run<void>(`${base}/${conversationId}`, 'PATCH', { shared }, conversationId),
        remove: (conversationId: number) => run<void>(`${base}/${conversationId}`, 'DELETE', undefined, conversationId),
    };
}

// --- Table, world and character sheet ------------------------------------

export function useCampaignMembers(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'members'],
        queryFn: () => apiFetch<CampaignMember[]>(`/campaigns/${campaignId}/members`),
        enabled: !!campaignId,
    });
}

export function useCampaignSettings(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'settings'],
        queryFn: () => apiFetch<CampaignSettings>(`/campaigns/${campaignId}/settings`),
        enabled: !!campaignId,
    });
}

export function useCampaignAdminActions(campaignId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const invalidate = useCallback(() => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'settings'] }),
        queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'members'] }),
        // The name and year also appear in the header and in the campaign list.
        queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] }),
        queryClient.invalidateQueries({ queryKey: ['guilds'] }),
    ]), [campaignId, queryClient]);

    const run = useCallback(async <T,>(path: string, method: string, body?: unknown): Promise<T | null> => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<T>(path, {
                method,
                ...(body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }),
            });
            await invalidate();
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [invalidate]);

    return {
        busy,
        error,
        setError,
        updateSettings: (patch: Partial<Omit<CampaignSettings, 'id'>>) =>
            run<CampaignSettings>(`/campaigns/${campaignId}/settings`, 'PATCH', patch),
        setMemberRole: (userId: string, role: 'MASTER' | 'PLAYER') =>
            run<void>(`/campaigns/${campaignId}/members/${encodeURIComponent(userId)}`, 'PATCH', { role }),
        removeMember: (userId: string) =>
            run<void>(`/campaigns/${campaignId}/members/${encodeURIComponent(userId)}`, 'DELETE'),
    };
}

export function useCreateCampaign(guildId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const create = useCallback(async (input: CreateCampaignInput): Promise<CampaignSummary | null> => {
        setBusy(true);
        setError(null);
        try {
            const created = await apiFetch<CampaignSummary>(`/guilds/${guildId}/campaigns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            await queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'campaigns'] });
            return created;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [guildId, queryClient]);

    return { create, busy, error, setError };
}

export function useCharacterSheet(campaignId: string, userId: string | null) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'characters', userId, 'sheet'],
        queryFn: () => apiFetch<CharacterSheet>(
            `/campaigns/${campaignId}/characters/${encodeURIComponent(userId!)}/sheet`,
        ),
        enabled: !!campaignId && !!userId,
        retry: false, // a 404 means "you have no character yet", not a failure
    });
}

export function useCharacterActions(campaignId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const invalidate = useCallback(() => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'characters'] }),
        queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'party'] }),
        queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'members'] }),
    ]), [campaignId, queryClient]);

    const run = useCallback(async <T,>(path: string, method: string, body?: unknown): Promise<T | null> => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<T>(path, {
                method,
                ...(body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }),
            });
            await invalidate();
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [invalidate]);

    return {
        busy,
        error,
        setError,
        saveOwnSheet: (patch: Partial<Omit<CharacterSheet, 'user_id' | 'is_manual'>>) =>
            run<CharacterSheet>(`/campaigns/${campaignId}/characters/me`, 'PUT', patch),
        saveSheet: (userId: string, patch: Partial<Omit<CharacterSheet, 'user_id' | 'is_manual'>>) =>
            run<CharacterSheet>(`/campaigns/${campaignId}/characters/${encodeURIComponent(userId)}/sheet`, 'PATCH', patch),
        estimateBio: (userId: string) => apiFetch<BioRegenEstimate>(
            `/campaigns/${campaignId}/characters/${encodeURIComponent(userId)}/bio/estimate`,
        ),
        regenerateBio: (userId: string) =>
            run<BioRegenResult>(`/campaigns/${campaignId}/characters/${encodeURIComponent(userId)}/bio`, 'POST'),
    };
}

// --- The table's AI settings (BYOK) ---

export function useGuildAiSettings(guildId: string) {
    return useQuery({
        queryKey: ['guilds', guildId, 'ai-settings'],
        queryFn: () => apiFetch<GuildAiSettings>(`/guilds/${guildId}/ai-settings`),
        enabled: !!guildId,
    });
}

/**
 * The models this table can choose from.
 *
 * The catalogue used to be cached forever, with a comment saying it was static.
 * It is not any more: a nightly job rebuilds it, and for Ollama the answer comes
 * from the table's own node — which changes the moment someone pulls a model.
 * An hour is long enough to keep a settings page snappy and short enough that a
 * refresh is not something to explain to anyone.
 */
export function useProviderModels(guildId: string, provider: AiProvider | null) {
    return useQuery({
        queryKey: ['guilds', guildId, 'ai-settings', 'models', provider],
        queryFn: () => apiFetch<ProviderModels>(`/guilds/${guildId}/ai-settings/models?provider=${provider}`),
        enabled: !!guildId && !!provider,
        staleTime: 60 * 60 * 1000,
    });
}

/**
 * The Whisper models installed on the table's PC.
 *
 * Not retried: the usual reason for an empty answer is that the machine is off,
 * and hammering it changes nothing. The answer carries its own reason.
 */
export function useRemoteWhisperModels(guildId: string, enabled: boolean) {
    return useQuery({
        queryKey: ['guilds', guildId, 'ai-settings', 'transcription', 'models'],
        queryFn: () => apiFetch<RemoteWhisperModels>(`/guilds/${guildId}/ai-settings/transcription/models`),
        enabled: !!guildId && enabled,
        retry: false,
        staleTime: 60 * 1000,
    });
}

/**
 * Writes to the AI settings.
 *
 * Keys are only ever sent: they never come back from any route, so the field is
 * never filled with an existing value and it is cleared after saving. `hint` is
 * all that can be shown.
 */
export function useGuildAiSettingsActions(guildId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const invalidate = useCallback(
        () => queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'ai-settings'] }),
        [guildId, queryClient],
    );

    const run = useCallback(async <T,>(path: string, method: string, body?: unknown): Promise<T | null> => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<T>(path, {
                method,
                ...(body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }),
            });
            await invalidate();
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [invalidate]);

    const base = `/guilds/${guildId}/ai-settings`;

    return {
        busy,
        error,
        setError,
        saveTiers: (patch: {
            quality?: TierChoice | null;
            fast?: TierChoice | null;
            image?: TierChoice | null;
        }) =>
            run<GuildAiSettings>(base, 'PUT', patch),
        saveKey: (provider: AiProvider, apiKey: string) =>
            run<void>(`${base}/credentials/${provider}`, 'PUT', { api_key: apiKey }),
        removeKey: (provider: AiProvider) =>
            run<void>(`${base}/credentials/${provider}`, 'DELETE'),
        testKey: (provider: AiProvider) =>
            run<AiCredentialTestResult>(`${base}/credentials/${provider}/test`, 'POST'),
    };
}

/** State of the legal documents for the current user. */
export function useLegalStatus() {
    return useQuery({
        queryKey: ['me', 'legal'],
        queryFn: () => apiFetch<LegalStatus>('/me/legal'),
    });
}

/**
 * Records the acceptance.
 *
 * We send the document names, not the versions: the server decides those.
 * Declaring a version from the client would mean being able to claim to have
 * accepted a text you never saw.
 */
export function useAcceptLegal() {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const accept = useCallback(async (documents: LegalDocumentName[]) => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<LegalStatus>('/me/legal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documents }),
            });
            await queryClient.invalidateQueries({ queryKey: ['me', 'legal'] });
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [queryClient]);

    return { accept, busy, error };
}

/** Estimate for a session of several hours, for this guild. */
export function useSessionEstimate(guildId: string, minutes: number) {
    return useQuery({
        queryKey: ['guilds', guildId, 'ai-settings', 'session-estimate', minutes],
        queryFn: () => apiFetch<SessionCostEstimate>(
            `/guilds/${guildId}/ai-settings/session-estimate?minutes=${minutes}`,
        ),
        enabled: !!guildId,
    });
}

export function usePricingOverrides(guildId: string) {
    return useQuery({
        queryKey: ['guilds', guildId, 'ai-settings', 'pricing'],
        queryFn: () => apiFetch<PricingOverride[]>(`/guilds/${guildId}/ai-settings/pricing`),
        enabled: !!guildId,
    });
}

/**
 * Rates declared by the table.
 *
 * They win over our price list: anyone with an enterprise discount or using the
 * Batch API really does pay something else, and imposing our prices on them
 * would be a lie about their own invoice.
 */
export function usePricingActions(guildId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = useCallback(async (overrides: PricingOverride[]) => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<PricingOverride[]>(`/guilds/${guildId}/ai-settings/pricing`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ overrides }),
            });
            await queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'ai-settings'] });
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [guildId, queryClient]);

    return { save, busy, error };
}

export function useTranscriptionSettings(guildId: string) {
    return useQuery({
        queryKey: ['guilds', guildId, 'ai-settings', 'transcription'],
        queryFn: () => apiFetch<TranscriptionSettings>(`/guilds/${guildId}/ai-settings/transcription`),
        enabled: !!guildId,
    });
}

export function useWakeMethods(guildId: string) {
    return useQuery({
        queryKey: ['guilds', guildId, 'ai-settings', 'wake-methods'],
        queryFn: () => apiFetch<WakeMethod[]>(`/guilds/${guildId}/ai-settings/wake-methods`),
        enabled: !!guildId,
        staleTime: Infinity, // the list of methods does not change at runtime
    });
}

/**
 * Writes to the transcription settings.
 *
 * `test` and `wake` are two deliberately distinct actions: a boot legitimately
 * takes minutes, and hiding it inside the test would make a PC that is merely
 * starting up look broken.
 */
export function useTranscriptionActions(guildId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = useCallback(async <T,>(path: string, method: string, body?: unknown): Promise<T | null> => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<T>(path, {
                method,
                ...(body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }),
            });
            await queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'ai-settings'] });
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [guildId, queryClient]);

    const base = `/guilds/${guildId}/ai-settings/transcription`;

    return {
        busy,
        error,
        save: (patch: TranscriptionPatch) => run<TranscriptionSettings>(base, 'PUT', patch),
        test: () => run<TranscriptionProbe>(`${base}/test`, 'POST'),
        wake: () => run<TranscriptionProbe>(`${base}/wake`, 'POST'),
        saveWakeSecret: (method: string, field: string, value: string) =>
            run<void>(`/guilds/${guildId}/ai-settings/wake-secrets/${method}/${field}`, 'PUT', { value }),
        saveAuthToken: (value: string) => run<void>(`${base}/auth-token`, 'PUT', { value }),
    };
}

/** What this campaign will actually use, and the overrides set on it. */
export function useCampaignAiSettings(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ai-settings'],
        queryFn: () => apiFetch<CampaignAiSettings>(`/campaigns/${campaignId}/ai-settings/effective`),
        enabled: !!campaignId,
    });
}

/**
 * Per-phase overrides, from a campaign's advanced settings.
 *
 * Models only: the keys belong to the server and cannot be named from here.
 * The advanced section moves which model, never who pays.
 */
export function useCampaignAiPhaseActions(campaignId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = useCallback(async (overrides: AiPhaseOverride[]) => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<AiPhaseOverride[]>(
                `/campaigns/${campaignId}/ai-settings/phases`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ overrides }),
                },
            );
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'ai-settings'] });
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [campaignId, queryClient]);

    return { save, busy, error };
}

/**
 * What one phase would cost with a model that has not been chosen yet.
 *
 * Keyed on the candidate, so switching between two models in a select shows
 * each figure once and then serves it from cache — the question «and if I
 * picked this one?» is asked repeatedly, and it should not cost a round trip
 * every time.
 */
export function usePhaseCostEstimate(
    campaignId: string,
    phase: string,
    provider: AiProvider | null,
    model: string,
) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ai-settings', 'phase-estimate', phase, provider, model],
        queryFn: () => apiFetch<PhaseModelCost>(
            `/campaigns/${campaignId}/ai-settings/phase-estimate`
            + `?phase=${encodeURIComponent(phase)}`
            + `&provider=${encodeURIComponent(provider ?? '')}`
            + `&model=${encodeURIComponent(model)}`,
        ),
        enabled: !!campaignId && !!provider && model.trim() !== '',
        retry: false,
        staleTime: 5 * 60 * 1000,
    });
}

/** A campaign's transcription model. The engine stays the guild's. */
export function useCampaignTranscription(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ai-settings', 'transcription'],
        queryFn: () => apiFetch<CampaignTranscription>(`/campaigns/${campaignId}/ai-settings/transcription`),
        enabled: !!campaignId,
    });
}

export function useCampaignTranscriptionActions(campaignId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = useCallback(async (patch: { cloud_model?: string | null; remote_model?: string | null }) => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<CampaignTranscription>(
                `/campaigns/${campaignId}/ai-settings/transcription`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patch),
                },
            );
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'ai-settings'] });
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [campaignId, queryClient]);

    return { save, busy, error };
}

export function useCampaignEmbedding(campaignId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ai-settings', 'embedding'],
        queryFn: () => apiFetch<CampaignEmbedding>(`/campaigns/${campaignId}/ai-settings/embedding`),
        enabled: !!campaignId,
    });
}

/**
 * Changing the embedding model, with a reindex.
 *
 * The estimate is asked for first: changing model makes everything the campaign
 * remembers invisible until the vectors have been recomputed, and how much that
 * costs depends on how many fragments it has accumulated.
 */
export function useCampaignEmbeddingActions(campaignId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const estimate = useCallback(
        (model: string) => apiFetch<ReindexEstimate>(
            `/campaigns/${campaignId}/ai-settings/embedding/estimate?model=${encodeURIComponent(model)}`,
        ),
        [campaignId],
    );

    const reindex = useCallback(async (model: string) => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<ReindexResult>(
                `/campaigns/${campaignId}/ai-settings/embedding/reindex`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model }),
                },
            );
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'ai-settings'] });
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [campaignId, queryClient]);

    return { estimate, reindex, busy, error };
}

/** Choice of the summary pipeline, per campaign. */
export function useCampaignFlowActions(campaignId: string) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = useCallback(async (agenticSummary: boolean) => {
        setBusy(true);
        setError(null);
        try {
            const result = await apiFetch<{ agentic_summary: boolean }>(
                `/campaigns/${campaignId}/ai-settings/flow`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentic_summary: agenticSummary }),
                },
            );
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'ai-settings'] });
            return result;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Request failed');
            return null;
        } finally {
            setBusy(false);
        }
    }, [campaignId, queryClient]);

    return { save, busy, error };
}

/**
 * The pictures a generation could draw from.
 *
 * Listed, never pre-chosen: each one is input tokens on the table's own
 * provider account, so they travel because somebody ticked them.
 */
export function useGenerationReferences(
    campaignId: string,
    entityType: MediaEntityType,
    entityId: string,
) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'reference-candidates', entityType, entityId],
        queryFn: () => apiFetch<ReferenceCandidate[]>(
            `/campaigns/${campaignId}/${entityType}/${encodeURIComponent(entityId)}/image/generate/references`,
        ),
        enabled: !!campaignId && !!entityId,
    });
}

/** Every picture of one entity, the main one first. */
export function useEntityImages(campaignId: string, entityType: MediaEntityType, entityId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'images', entityType, entityId],
        queryFn: () => apiFetch<EntityImage[]>(
            `/campaigns/${campaignId}/${entityType}/${encodeURIComponent(entityId)}/images`,
        ),
        enabled: !!campaignId && !!entityId,
    });
}

/**
 * The appearance dossier of one entity.
 *
 * A 204 comes back as null rather than an error: a subject nobody has analysed
 * yet is the ordinary state of a campaign, not a failure.
 */
export function useEntityProfile(campaignId: string, entityType: MediaEntityType, entityId: string) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'profile', entityType, entityId],
        queryFn: () => apiFetch<EntityProfile | null>(
            `/campaigns/${campaignId}/${entityType}/${encodeURIComponent(entityId)}/profile`,
        ),
        enabled: !!campaignId && !!entityId,
    });
}

/** The reference pictures of one scope, and the two ways to change that set. */
export function useReferenceImages(
    campaignId: string,
    scope: ReferenceScope,
    key: string,
    enabled = true,
) {
    const queryClient = useQueryClient();
    const params = new URLSearchParams({ scope });
    if (key) params.set('key', key);

    const query = useQuery({
        queryKey: ['campaigns', campaignId, 'references', scope, key],
        queryFn: () => apiFetch<ReferenceImage[]>(`/campaigns/${campaignId}/references?${params.toString()}`),
        enabled: enabled && !!campaignId,
    });

    const invalidate = () => queryClient.invalidateQueries({
        queryKey: ['campaigns', campaignId, 'references', scope, key],
    });

    async function add(file: File, label: string | null) {
        const body = new FormData();
        body.append('file', file);
        body.append('scope', scope);
        if (key) body.append('key', key);
        if (label) body.append('label', label);
        const saved = await apiFetch<ReferenceImage>(`/campaigns/${campaignId}/references`, {
            method: 'POST',
            body,
        });
        await invalidate();
        return saved;
    }

    async function remove(id: string) {
        await apiFetch<void>(`/campaigns/${campaignId}/references/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        await invalidate();
    }

    return { ...query, add, remove };
}

/**
 * A person's own AI work, kept live.
 *
 * **Server-sent events, with a poll underneath.** The stream is what makes the
 * corner card turn green the instant a picture is ready, and it costs one idle
 * connection instead of a request every few seconds. But a stream is a courtesy
 * and not the record: a proxy that closes idle connections, a laptop that slept,
 * a browser that never opened it — all of them have to end up with the truth
 * anyway. So the query stays the source, the stream only tells it to refetch,
 * and a slow interval runs while something is actually in flight.
 *
 * The list is scoped to the caller by the server (`requested_by = me`), which is
 * why this needs no campaign in its key: you cannot see work you did not start.
 */
export function useMyAiJobs() {
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: ['me', 'ai-jobs'],
        queryFn: () => apiFetch<MyAiJobs>('/me/ai-jobs?limit=20'),
        // The global 30s staleness would make a 20-second job look stuck.
        staleTime: 0,
        // Only while something is moving: an idle table generates no traffic.
        refetchInterval: (query) => (query.state.data?.active_count ? 15_000 : false),
        refetchOnWindowFocus: true,
    });

    useEffect(() => {
        // `EventSource` reconnects on its own, so there is no retry loop here to
        // get wrong; if it never connects at all, the poll above still runs.
        const stream = new EventSource('/api/v1/me/ai-jobs/stream', { withCredentials: true });
        const refresh = () => {
            void queryClient.invalidateQueries({ queryKey: ['me', 'ai-jobs'] });
        };
        stream.addEventListener('job', refresh);
        return () => {
            stream.removeEventListener('job', refresh);
            stream.close();
        };
    }, [queryClient]);

    async function markSeen(ids?: string[]) {
        await apiFetch<void>('/me/ai-jobs/seen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        await queryClient.invalidateQueries({ queryKey: ['me', 'ai-jobs'] });
    }

    return { ...query, markSeen };
}

/**
 * One job, followed until it stops moving.
 *
 * The panel that started the work uses this to show its own progress; the
 * interval stops the moment the job reaches a state nothing will change on its
 * own, so a finished job costs nothing to keep on screen.
 */
export function useAiJob(campaignId: string, jobId: string | null) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'ai-jobs', jobId],
        queryFn: () => apiFetch<AiJob>(`/campaigns/${campaignId}/ai-jobs/${jobId}`),
        enabled: !!campaignId && !!jobId,
        staleTime: 0,
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            return status && TERMINAL_AI_JOB_STATUSES.includes(status) ? false : 2_000;
        },
        refetchOnWindowFocus: true,
    });
}

/** The generation this entity already has in flight, if any. */
export function usePendingImageJob(
    campaignId: string,
    entityType: MediaEntityType,
    entityId: string,
) {
    return useQuery({
        queryKey: ['campaigns', campaignId, 'image-pending', entityType, entityId],
        queryFn: () => apiFetch<AiJob | null>(
            `/campaigns/${campaignId}/${entityType}/${encodeURIComponent(entityId)}/image/generate/pending`,
        ),
        enabled: !!campaignId && !!entityId,
        staleTime: 0,
    });
}
