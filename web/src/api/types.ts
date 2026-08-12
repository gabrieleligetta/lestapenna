export interface Me {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
}

/**
 * What this instance says about itself, readable without a session.
 *
 * A fork changes its own links from the environment, so these cannot be baked
 * into the bundle at build time.
 */
export interface AppInfo {
    donation: {
        /** Empty when this instance asks for nothing: the item disappears. */
        url: string;
        /** False when the URL exists but does not accept money yet. */
        active: boolean;
    };
    repo_url: string;
    license: string;
}

export interface GuildSummary {
    id: string;
    name: string;
    icon: string | null;
    canManage: boolean;
}

export interface CampaignSummary {
    id: number;
    name: string;
    isActive: boolean;
    currentYear: number | null;
    currentLocation: { macro: string | null; micro: string | null } | null;
    language: string | null;
}

/** The caller's role in the campaign; `null` for anyone not at the table. */
export type CampaignRole = 'MASTER' | 'PLAYER';

export interface CampaignOverview {
    id: number;
    name: string;
    /**
     * Permissions come from the server and must not be re-derived here: being an
     * administrator of the Discord guild and being part of the table are two
     * different things, and only the backend knows the campaign's membership.
     */
    myRole: CampaignRole | null;
    canWrite: boolean;
    canManageMembers: boolean;
    currentYear: number | null;
    currentLocation: { macro: string | null; micro: string | null } | null;
    partyAlignment: { moral: string | null; ethical: string | null };
    party: Array<{
        userId: string;
        name: string;
        race: string | null;
        class: string | null;
        image?: EntityImage | null;
    }>;
    lastSession: { session_id: string; start_time: number; session_number: number | null; title: string | null } | null;
    counts: {
        sessions: number;
        openQuests: number;
        npcs: number;
        locations: number;
        factions: number;
        inventory: number;
        artifacts: number;
        bestiary: number;
    };
}

export type MoralLabel = 'GOOD' | 'NEUTRAL' | 'EVIL';
export type EthicalLabel = 'LAWFUL' | 'NEUTRAL' | 'CHAOTIC';

/**
 * Alignment as the API computes it. `label` and `cell` are applied server-side
 * from the ±25 thresholds in src/utils/alignmentUtils.ts — the SPA renders them
 * and never re-derives them, or the two surfaces drift apart.
 */
export interface Alignment {
    moral: { score: number; label: MoralLabel };
    ethical: { score: number; label: EthicalLabel };
    cell: string;
}

export interface EntityImage {
    id: string;
    /** True on the one picture the sheet shows; the rest are the gallery. */
    isPrimary?: boolean;
    thumbnailUrl: string;
    displayUrl: string;
    width: number;
    height: number;
    focalX?: number;
    focalY?: number;
    altText: string | null;
    /** Uploaded by hand, or generated. */
    source?: EntityImageSource;
    /**
     * How a generated picture was asked for, and in the person's own words.
     *
     * They are what makes a repeat possible: the panel reopens with this mode
     * selected and this text back in an editable field, so the same request can
     * be run again unchanged or amended first.
     */
    generationMode?: ImageGenerationMode | null;
    generationPrompt?: string | null;
    updatedAt: number;
}

export type EntityImageSource = 'upload' | 'ai';
export type ImageGenerationMode = 'auto' | 'prompt' | 'mixed';

/** What a portrait will cost, before anything is spent. */
export interface ImageGenerationEstimate {
    mode: ImageGenerationMode;
    provider: string;
    model: string;
    /** The model that writes the brief first, in the modes that use one. */
    text_provider: string | null;
    text_model: string | null;
    billable: boolean;
    /** False when we do not know the rate. That is not the same as free. */
    pricing_available: boolean;
    estimated_cost_usd: number | null;
    estimated_cost_eur: number | null;
    exchange_rate: AiExchangeRate;
}

/** One piece of paid AI work, as the register records it. */
export interface AiJob {
    id: string;
    campaign_id: number;
    guild_id: string;
    kind: 'image' | 'appearance' | 'quest-audit' | 'character-bio';
    target_type: 'npc' | 'location' | 'character' | 'artifact' | 'campaign';
    /** The public short id — what the sheet's URL carries. */
    target_key: string;
    target_label: string | null;
    requested_by: string;
    status: AiJobStatus;
    error_kind: AiJobErrorKind | null;
    error_message: string | null;
    provider: string | null;
    model: string | null;
    /** Null means unknown, never free. */
    cost_usd: number | null;
    cost_eur: number | null;
    pricing_available: boolean;
    /** True once the provider answered: from here the money is gone. */
    charged: boolean;
    seen_at: number | null;
    created_at: number;
    finished_at: number | null;
    expires_at: number | null;
    result?: Record<string, unknown> | null;
    prompt?: string | null;
}

export type AiJobStatus =
    | 'queued' | 'running' | 'awaiting_review'
    | 'succeeded' | 'discarded' | 'failed' | 'expired';

export type AiJobErrorKind =
    | 'refused' | 'not_configured' | 'provider' | 'storage' | 'interrupted' | 'internal';

/** What a POST that starts paid work answers with. */
export interface AiJobAccepted {
    job_id: string;
    status: AiJobStatus;
}

export interface MyAiJobs {
    items: AiJob[];
    unseen_count: number;
    active_count: number;
}

/** Nothing more happens to these on their own. */
export const TERMINAL_AI_JOB_STATUSES: AiJobStatus[] = [
    'succeeded', 'discarded', 'failed', 'expired',
];


export type MediaEntityType = 'npc' | 'location' | 'character' | 'artifact';

export type TraitSource = 'sheet' | 'history' | 'faction' | 'transcript' | 'rag';
export type TraitConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Where one recorded trait came from.
 *
 * Shown on the sheet, not just stored: a dossier a reader can check a line at a
 * time is the only kind worth drawing a portrait from.
 */
export interface TraitEvidence {
    trait: string;
    quote: string;
    source: TraitSource;
    session_id: string | null;
}

/** What the campaign records about how an entity looks and behaves. */
export type ShotFraming = 'face' | 'bust' | 'half' | 'full' | 'wide' | 'detail';
export type ShotPose = 'frontal' | 'three_quarter' | 'profile' | 'back' | 'action' | 'seated';
export type ShotLight = 'soft' | 'dramatic' | 'backlit' | 'candlelight' | 'daylight' | 'night';
export type ShotBackground = 'neutral' | 'location' | 'dark' | 'light';

/** How the picture should be taken, as opposed to what is in it. */
export interface ImageShot {
    framing?: ShotFraming | null;
    pose?: ShotPose | null;
    light?: ShotLight | null;
    background?: ShotBackground | null;
}

/** A picture a generation could draw from, for the picker to list. */
export interface ReferenceCandidate {
    id: string;
    /** `scratch` is a picture handed to one generation and stored nowhere. */
    scope: ReferenceScope | 'scratch';
    imageUrl: string;
    label: string | null;
}

export interface EntityProfile {
    /** Which vocabulary of visible traits applies. */
    kind: 'person' | 'place' | 'object';
    /** Every field this kind of subject can have, in the order to show them. */
    fields: string[];
    /** The fields a person filled in by hand; an analysis never touches these. */
    manual_fields: string[];
    appearance: Record<string, unknown> | null;
    appearance_text: string | null;
    personality: Record<string, unknown> | null;
    personality_text: string | null;
    evidence: TraitEvidence[];
    confidence: TraitConfidence | null;
    /** Written by hand: a re-analysis leaves it alone. */
    is_manual: boolean;
    provider: string | null;
    model: string | null;
    generated_at: number | null;
    /** The first session that moved past this dossier. Never spends by itself. */
    stale_since_session_id: string | null;
}

export interface EntityProfileEstimate {
    provider: string;
    model: string;
    billable: boolean;
    /** False when we do not know the rate. That is not the same as free. */
    pricing_available: boolean;
    estimated_cost_usd: { min: number; max: number } | null;
    estimated_cost_eur: { min: number; max: number } | null;
}

export interface EntityProfileAnalysis {
    profile: EntityProfile;
    /** What was looked for and the records genuinely do not hold. */
    not_recorded: string[];
    /** Fields the analysis stepped around because a person owns them. */
    kept_fields: string[];
    cost_usd: number | null;
    cost_eur: number | null;
    pricing_available: boolean;
}

export type ReferenceScope = 'campaign' | 'faction' | 'entity';

export interface ReferenceImage {
    id: string;
    imageUrl: string;
    scope: ReferenceScope;
    scope_key: string;
    width: number;
    height: number;
    label: string | null;
    created_at: number;
}

export type InventoryCategory =
    | 'WEAPON'
    | 'ARMOR'
    | 'CONSUMABLE'
    | 'TOOL'
    | 'MATERIAL'
    | 'TREASURE'
    | 'QUEST_ITEM'
    | 'OTHER';

export const QUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED'] as const;
export type QuestStatus = typeof QUEST_STATUSES[number];
export const QUEST_TYPES = ['MAJOR', 'MINOR'] as const;
export type QuestType = typeof QUEST_TYPES[number];

export interface QuestDetail extends EntityRow {
    id: number;
    short_id: string;
    campaign_id: number;
    title: string;
    description: string | null;
    status: QuestStatus;
    type: QuestType;
    created_at: number;
    last_updated: number;
    session_id: string | null;
    is_manual: number;
}

export interface QuestMutation {
    title: string;
    description: string | null;
    status: QuestStatus;
    type: QuestType;
}

export interface QuestLifecycleSuggestion {
    id: number;
    campaign_id: number;
    quest_id: number | null;
    session_id: string | null;
    proposed_action: 'CREATE' | 'STATUS_CHANGE';
    proposed_title: string;
    proposed_description: string | null;
    proposed_status: QuestStatus;
    proposed_type: QuestType;
    evidence: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    status: 'PENDING' | 'APPLIED' | 'DISMISSED';
    created_at: number;
    resolved_at: number | null;
}

export type AiExchangeRate = {
    source: 'ECB' | 'STALE_ECB' | 'UNAVAILABLE';
    usd_per_eur: number | null;
    rate_date: string | null;
    fetched_at: number | null;
};

export interface QuestAuditEstimate {
    status: 'READY' | 'RUNNING' | 'COOLDOWN' | 'NO_SESSIONS' | 'NOTHING_TO_AUDIT';
    will_invoke_ai: boolean;
    billable: boolean;
    pricing_available: boolean;
    provider: string;
    model: string;
    session_count: number;
    open_quest_count: number;
    pending_suggestion_count: number;
    estimated_tokens: {
        input_min: number;
        input_max: number;
        output_min: number;
        output_max: number;
    } | null;
    estimated_cost_usd: { min: number; max: number } | null;
    estimated_cost_eur: { min: number; max: number } | null;
    exchange_rate: AiExchangeRate;
    cooldown_ends_at: number | null;
}

export interface QuestAuditStart {
    /** Null when nothing was worth starting — and nothing was spent. */
    job_id: string | null;
    invoked_ai: boolean;
    skipped_reason: 'COOLDOWN' | 'NOTHING_TO_AUDIT' | null;
}

export interface PartyMember {
    userId: string;
    name: string | null;
    race: string | null;
    class: string | null;
    /** Null for a member with no affiliation row — the DM, typically. */
    role: string | null;
    alignment: Alignment;
    hasBio: boolean;
    image?: EntityImage | null;
}

export interface Party {
    name: string | null;
    factionShortId: string | null;
    alignmentSource: 'faction' | 'campaign';
    alignment: Alignment;
    members: PartyMember[];
}

export type ReputationLevel =
    | 'HOSTILE'
    | 'DISTRUSTFUL'
    | 'COLD'
    | 'NEUTRAL'
    | 'CORDIAL'
    | 'FRIENDLY'
    | 'ALLIED';

export interface FactionDetail {
    short_id: string;
    name: string;
    description: string | null;
    type: string;
    status: string;
    is_party: number;
    alignment: Alignment;
    reputation: ReputationLevel;
    memberCounts: { npcs: number; locations: number; pcs: number };
    last_updated: string | null;
}

export interface Affiliation {
    factionName: string;
    factionShortId: string | null;
    role: string;
    notes: string | null;
}

export interface NpcDetail {
    short_id: string;
    name: string;
    role: string | null;
    status: string;
    description: string | null;
    aliases: string | null;
    alignment: Alignment;
    factions: Affiliation[];
    last_updated: string | null;
    image?: EntityImage | null;
}

export interface LocationDetail {
    short_id: string;
    macro_location: string;
    micro_location: string;
    description: string | null;
    factions: Affiliation[];
    last_updated: string | null;
    image?: EntityImage | null;
}

export interface CharacterDetail {
    userId: string;
    character_name: string | null;
    race: string | null;
    class: string | null;
    description: string | null;
    foundation_description: string | null;
    alignment: Alignment;
    factions: Affiliation[];
    /** Present only on your own sheet — the one non-lore column on `characters`. */
    email?: string | null;
    image?: EntityImage | null;
}

export interface ArtifactDetail extends EntityRow {
    short_id: string;
    name: string;
    description: string | null;
    effects: string | null;
    is_cursed: number;
    curse_description: string | null;
    owner_type: string | null;
    owner_name: string | null;
    location_macro: string | null;
    location_micro: string | null;
    status: string;
    last_updated: string | null;
    image?: EntityImage | null;
}

export interface InventoryDetail extends EntityRow {
    short_id: string;
    item_name: string;
    description: string | null;
    notes: string | null;
    quantity: number;
    category: InventoryCategory;
    acquired_at: number | null;
    last_updated: number | null;
    is_artifact?: boolean;
    artifact_short_id?: string | null;
    artifact_status?: string | null;
    is_cursed?: boolean | null;
    image?: EntityImage | null;
}

export interface FactionMember {
    entityType: 'npc' | 'location' | 'pc';
    name: string | null;
    role: string;
    /** NPCs and locations link by short_id; characters have none and carry userId instead. */
    shortId: string | null;
    userId: string | null;
    notes: string | null;
}

/** The 9 campaign entity list endpoints + sessions — rows are ~as-is from the repository layer (see roadmap 2.4 notes). */
export type EntityType =
    | 'characters'
    | 'npcs'
    | 'locations'
    | 'factions'
    | 'quests'
    | 'inventory'
    | 'artifacts'
    | 'bestiary'
    | 'timeline'
    | 'sessions';

export type EntityRow = Record<string, unknown>;

/** Entity families currently backed by a merge adapter on the API. */
export const MERGEABLE_ENTITY_TYPES = ['artifacts', 'npcs', 'factions'] as const;
export type MergeableEntityType = typeof MERGEABLE_ENTITY_TYPES[number];

export function isMergeableEntityType(value: EntityType): value is MergeableEntityType {
    return MERGEABLE_ENTITY_TYPES.includes(value as MergeableEntityType);
}

/**
 * Envelope returned by every list endpoint (src/api/common/pagination.ts).
 * `total` counts every matching row, not the page, so the UI can show a real
 * range instead of inferring "is there more?" from items.length.
 */
export interface Page<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}

/** Types that have a detail view + /:id/events history — everything except timeline (permalink-only) and sessions (own shape). */
export type EventedEntityType = Exclude<EntityType, 'timeline' | 'sessions'>;

/** Row shape from src/commands/utils/eventsViewer.ts — same for npc/locations/factions/quests/inventory/artifacts/bestiary/characters. */
export interface HistoryEvent {
    id: number;
    description: string;
    event_type: string;
    session_id: string | null;
    timestamp: number | null;
    is_manual?: number;
    /**
     * The event's contribution to the entity's alignment, on a −10..+10 scale.
     * Present only on NPCs, characters and factions: they are the only three
     * history tables that weight alignment. `null` elsewhere.
     */
    moral_weight?: number | null;
    ethical_weight?: number | null;
}

/** The fields of an event the editor can change. All optional: it is a patch. */
export interface EventMutation {
    description?: string;
    event_type?: string;
    moral_weight?: number;
    ethical_weight?: number;
}

/** The families with create/update/delete from the web (src/api/campaigns/crud). */
export const CRUD_ENTITY_TYPES = [
    'npcs',
    'locations',
    'factions',
    'quests',
    'inventory',
    'artifacts',
    'bestiary',
    'timeline',
] as const;
export type CrudEntityType = typeof CRUD_ENTITY_TYPES[number];

export function isCrudEntityType(value: string): value is CrudEntityType {
    return (CRUD_ENTITY_TYPES as readonly string[]).includes(value);
}

/** What the cascade deletion took away, beyond the entity row. */
export interface EntityDeleteReport {
    history_deleted: number;
    rag_fragments_deleted: number;
    rag_refs_stripped: number;
    affiliations_deleted: number;
    media_deleted: boolean;
}

export interface EntityDeleteResult {
    name: string;
    report: EntityDeleteReport;
}

/**
 * A fragment of long-term memory (RAG) that names the entity.
 *
 * `is_entity_snapshot` distinguishes the official card — regenerated by the
 * pipeline at every session — from session memories, which instead come from a
 * transcript and never come back once deleted.
 */
export interface EntityFragment {
    id: number;
    session_id: string | null;
    header: string;
    content: string;
    created_at: number | null;
    macro_location: string | null;
    micro_location: string | null;
    is_entity_snapshot: boolean;
}

/** A cross-reference to something the session produced, enough to render a link. */
export interface SessionRef {
    short_id: string | null;
    [key: string]: unknown;
}

export interface SessionSummary {
    session_id: string;
    start_time: number;
    session_number: number | null;
    title: string | null;
}

export interface SessionParticipant {
    userId: string;
    characterName: string | null;
    image?: EntityImage | null;
}

export interface SessionTranscriptItem {
    text: string;
    userId: string | null;
    characterName: string | null;
    timestamp: number | null;
    macroLocation: string | null;
    microLocation: string | null;
}

export interface SessionTranscript {
    items: SessionTranscriptItem[];
}

export interface SessionDetail extends EntityRow {
    session_id: string;
    start_time: number;
    session_number: number | null;
    title: string | null;
    campaign_name: string | null;
    brief: string | null;
    narrative: string | null;
    /** Generation metadata — tone, act count, token cost. The bot never shows this. */
    metadata: { title: string; tone: string; tokens: number; generatedAt: number; acts: number } | null;
    notes: Array<{ id: number; user_id: string; content: string; timestamp: number }>;
    npcsEncountered: Array<SessionRef & { name: string; role: string | null; status: string }>;
    quests: Array<SessionRef & { title: string; status: string }>;
    inventory: Array<SessionRef & {
        item_name: string;
        quantity: number;
        category?: InventoryCategory;
        is_artifact?: boolean;
        is_cursed?: boolean;
        image?: EntityImage | null;
    }>;
    bestiary: Array<SessionRef & { name: string; status: string }>;
    travels: Array<{ macro_location: string; micro_location: string; timestamp: number }>;
    /** Additive reader data. Optional while older API deployments are still live. */
    navigation?: {
        previous: SessionSummary | null;
        next: SessionSummary | null;
    };
    participants?: SessionParticipant[];
    media?: {
        audioAvailable: boolean;
        transcriptAvailable: boolean;
    };
}

// --- Merge duplicates (artifacts + npcs + factions) ---

export interface DuplicateMember {
    short_id: string;
    name: string;
    is_manual: number;
    history_count: number;
    has_rag: boolean;
    description: string | null;
    score: number;
    reason: string;
}

export interface DuplicateCluster {
    id: string;
    members: DuplicateMember[];
    suggested_survivor: string;
}

export interface DuplicatesResult {
    clusters: DuplicateCluster[];
}

export interface MergeReport {
    merged_rows: Array<{ short_id: string; name: string }>;
    history_repointed: number;
    rag_fragments_deleted: number;
    rag_refs_rewritten: number;
    relations_repointed: number;
    short_id_regenerated: boolean;
    manual_propagated: boolean;
    bio_auto_merged?: boolean;
    renamed?: { from: string; to: string };
}

export interface MergeResult {
    survivor_short_id: string;
    survivor_name: string;
    report: MergeReport;
}

export interface RecordFieldDiff {
    field: string;
    survivor_value: string | null;
    drop_short_id: string;
    drop_name: string;
    drop_value: string | null;
    verdict: 'kept' | 'discarded' | 'differs';
}

export interface MergeHistoryEvent {
    drop_short_id: string;
    drop_name: string;
    event_type: string;
    session_date: string | null;
    description_preview: string;
}

export interface RagFragment {
    drop_short_id: string;
    drop_name: string;
    fragment_id: number;
    header: string;
    version_count: number;
    action: 'deleted' | 'consolidated' | 'rewritten' | 'kept';
}

export interface MergeRelationImpact {
    drop_short_id: string;
    drop_name: string;
    relation_type: string;
    label: string;
    action: 'repointed' | 'deduplicated';
}

export interface RenamePreview {
    from: string;
    to: string;
    history_repointed: number;
    rag_headers_rewritten: number;
}

export interface MergePreview {
    survivor_short_id: string;
    survivor_name: string;
    final_name: string;
    rename?: RenamePreview;
    record: RecordFieldDiff[];
    events: MergeHistoryEvent[];
    relations: MergeRelationImpact[];
    rag: RagFragment[];
}

// --- Chat col Bardo ------------------------------------------------------

/** Why a send would not be possible, stated before trying. */
export interface AskEstimate {
    /** The user's provider and model (BYOK) the exchange will be spent on. */
    provider: string;
    model: string;
}

export interface AskMessage {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    created_at: number;
    cost_usd: number | null;
    cost_eur: number | null;
    provider: string | null;
    model: string | null;
}

export interface AskConversation {
    id: number;
    title: string;
    shared: boolean;
    /** False when it is a conversation another member has shared. */
    owned: boolean;
    created_at: number;
    updated_at: number;
    message_count: number;
}

export interface AskConversationDetail extends AskConversation {
    messages: AskMessage[];
}

export interface AskAnswer {
    conversation: AskConversation;
    message: AskMessage;
}

// --- Table, world and character sheet ------------------------------------

export interface CampaignMember {
    user_id: string;
    role: 'MASTER' | 'PLAYER';
    character_name: string | null;
    /** Discord nickname on this server, else the global name. Null when Discord could not be reached. */
    display_name: string | null;
    username: string | null;
    /** False for someone who has a character here but holds no seat yet. */
    enrolled: boolean;
    added_at: number | null;
}

export interface CampaignSettings {
    id: number;
    name: string;
    language: string | null;
    current_year: number | null;
    party_name: string | null;
    allow_auto_character_update: boolean;
    /** The house style for generated pictures. Null keeps the built-in one. */
    art_direction: string | null;
}

export interface CreateCampaignInput {
    name: string;
    language?: string;
    current_year?: number;
    party_name?: string;
}

export interface CharacterSheet {
    user_id: string;
    character_name: string | null;
    race: string | null;
    class: string | null;
    description: string | null;
    is_manual: boolean;
}

export interface BioRegenEstimate {
    status: 'READY' | 'NO_HISTORY';
    will_invoke_ai: boolean;
    provider: string;
    model: string;
}

export interface BioRegenResult {
    character: CharacterSheet;
    invoked_ai: boolean;
    cost_usd: number | null;
    cost_eur: number | null;
}

// --- The table's AI settings (BYOK) ---

export type AiProvider = 'openai' | 'gemini' | 'anthropic' | 'ollama' | 'ollama-cloud';

export type AiTier = 'quality' | 'fast';

export type SecretVerifyStatus =
    | 'OK'
    | 'AUTH_FAILED'
    | 'QUOTA_EXHAUSTED'
    | 'UNREACHABLE'
    | 'UNDECRYPTABLE';

export interface TierChoice {
    provider: AiProvider;
    model: string;
}

export interface AiPhaseConfig {
    phase: string;
    provider: AiProvider;
    model: string;
    tier: AiTier | null;
}

/**
 * State of a credential. It never contains the key: only whether there is one,
 * how it ends, and what the provider last said about it.
 */
export interface AiCredentialStatus {
    provider: AiProvider;
    secret_key: string;
    configured: boolean;
    hint: string | null;
    verify_status: SecretVerifyStatus | null;
    verify_error: string | null;
    last_verified_at: number | null;
    updated_at: number | null;
}

export interface GuildAiSettings {
    guild_id: string;
    quality: TierChoice | null;
    fast: TierChoice | null;
    /** The model that draws entity portraits. Beside the two groups, not inside them. */
    image: TierChoice | null;
    effective: AiPhaseConfig[];
    credentials: AiCredentialStatus[];
    ready: boolean;
    missing_providers: AiProvider[];
    /** Whether the viewer can change keys and models. Anyone can look. */
    can_manage: boolean;
}

export interface AiCredentialTestResult {
    provider: AiProvider;
    status: SecretVerifyStatus;
    detail: string | null;
    model: string;
}

/**
 * One entry of a model select.
 *
 * The rates are numbers, not text spelled into `label`: the UI has to lay them
 * out and align them, which is what makes two models comparable at the moment
 * of the choice rather than afterwards on an invoice.
 *
 * A `null` rate means we do not know it — **never** that it is free. That is
 * what `runs_on_your_hardware` says.
 */
export interface AiModelOption {
    id: string;
    label: string | null;
    recommended: boolean;
    input_per_million: number | null;
    output_per_million: number | null;
    /** Transcription models only: they are billed per minute of audio. */
    per_minute_usd: number | null;
    /** Image models only: they are billed per generated picture. */
    per_image_usd: number | null;
    context_tokens: number | null;
    runs_on_your_hardware: boolean;
}

export interface ProviderModels {
    provider: AiProvider;
    quality: AiModelOption[];
    fast: AiModelOption[];
    transcription: AiModelOption[];
    /** Models that draw entity portraits. Empty for a provider that has none. */
    image: AiModelOption[];
    /** When the catalogue was last rebuilt. Null while it is still the curated list. */
    refreshed_at: number | null;
}

/** The Whisper models installed on the table's own PC. */
export interface RemoteWhisperModels {
    models: string[];
    current: string | null;
    /** Why the list is empty, when it is. A PC being off is not an error. */
    reason: 'NOT_REMOTE' | 'UNREACHABLE' | 'UNAUTHORIZED' | null;
}

/** What a phase would cost with a model that has not been chosen yet. */
export interface PhaseModelCost {
    phase: string;
    provider: AiProvider;
    model: string;
    audio_minutes: number;
    input_tokens: number;
    output_tokens: number;
    /** Null when the rate is unknown. Never zero for "we do not know". */
    cost_usd: number | null;
    cost_eur: number | null;
    pricing_source: 'builtin' | 'tenant_override' | 'free' | 'subscription' | 'unknown';
    /** True when the figure comes from this table's own past sessions. */
    calibrated: boolean;
    runs_on_your_hardware: boolean;
}

/** A campaign's transcription choice. The engine belongs to the guild. */
export interface CampaignTranscription {
    engine: 'remote' | 'cloud' | null;
    reason: 'NOT_CONFIGURED' | 'NO_CLOUD_KEY' | null;
    effective_model: string | null;
    effective_provider: AiProvider | null;
    cloud_model: string | null;
    remote_model: string | null;
    usd_per_minute: number | null;
}

// --- Documenti legali ---

export type LegalDocumentName = 'terms' | 'privacy';

export interface LegalDocumentStatus {
    document: LegalDocumentName;
    current_version: string;
    accepted_version: string | null;
    accepted_at: number | null;
    needs_acceptance: boolean;
}

export interface LegalStatus {
    documents: LegalDocumentStatus[];
    needs_acceptance: boolean;
}

// --- Costs ---

export type PricingSource = 'builtin' | 'tenant_override' | 'free' | 'subscription' | 'unknown';

export interface PhaseCostEstimate {
    phase: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    /** Null for phases billed per minute of audio rather than per token. */
    input_per_million: number | null;
    output_per_million: number | null;
    /** Null when we do not know the rate. Not zero. */
    cost_usd: number | null;
    pricing_source: PricingSource;
    resource_intensive: boolean;
}

export interface SessionCostEstimate {
    audio_minutes: number;
    per_phase: PhaseCostEstimate[];
    total_usd: number | null;
    total_eur: number | null;
    pricing_complete: boolean;
    resource_intensive_phases: string[];
    calibrated: boolean;
}

export interface PricingOverride {
    model: string;
    input_per_million: number;
    output_per_million: number;
    cached_input_per_million?: number;
    /** Image models are billed per picture, which the two rates above cannot express. */
    per_image_usd?: number;
}

// --- Campaign embedding ---

export interface EmbeddingModelOption {
    model: string;
    provider: AiProvider;
    dimension: number;
    usd_per_million_tokens: number;
}

export interface CampaignEmbedding {
    model: string | null;
    dimension: number | null;
    fragments: number;
    options: EmbeddingModelOption[];
}

export interface ReindexEstimate {
    fragments: number;
    current_model: string;
    target_model: string;
    estimated_usd: number | null;
}

export interface ReindexResult {
    reindexed: number;
    failed: number;
    model: string;
}

export interface AiPhaseOverride {
    phase: string;
    provider: AiProvider;
    model: string;
}

// --- Trascrizione ---

export type TranscriptionEngine = 'remote' | 'cloud';

export interface WakeField {
    name: string;
    kind: 'text' | 'password' | 'number' | 'url';
    label: string;
    hint: string | null;
    required: boolean;
    placeholder: string | null;
    secret: boolean;
}

/** A wake method, with the fields it asks for. The UI draws the form from this. */
export interface WakeMethod {
    id: string;
    label: string;
    description: string;
    fields: WakeField[];
}

export interface WakeSettings {
    mac_address: string | null;
    method: string;
    options: Record<string, string | number | undefined>;
    /** Names of the secret fields already stored. Never the values. */
    configured_secrets: string[];
}

export interface TranscriptionSettings {
    engine: TranscriptionEngine | null;
    remote: {
        url: string | null;
        /** Chosen among those installed on that PC. Null leaves the choice to the PC. */
        model: string | null;
        auth_token_configured: boolean;
        shutdown_enabled: boolean;
        wake: WakeSettings;
    };
    cloud: { provider: AiProvider; model: string };
    usable: boolean;
    reason: 'NOT_CONFIGURED' | 'NO_CLOUD_KEY' | null;
    cloud_usd_per_minute: number | null;
}

export interface TranscriptionPatch {
    engine?: TranscriptionEngine | null;
    remote_url?: string | null;
    shutdown_enabled?: boolean;
    wake?: { mac_address?: string | null; method?: string; options?: Record<string, string | number | undefined> };
    cloud_provider?: AiProvider;
    cloud_model?: string;
    /** Null clears the choice and leaves the model to the PC. */
    remote_model?: string | null;
}

export interface TranscriptionProbe {
    status: 'OK' | 'UNREACHABLE' | 'UNAUTHORIZED' | 'NOT_CONFIGURED';
    detail: string | null;
}

export interface CampaignAiSettings {
    campaign_id: number;
    guild_id: string;
    effective: AiPhaseConfig[];
    can_manage: boolean;
    ready: boolean;
    /** Per-phase overrides for THIS campaign. Models only: the keys belong to the server. */
    overrides: AiPhaseOverride[];
    /** The semi-agentic pipeline instead of the linear one. */
    agentic_summary: boolean;
}
