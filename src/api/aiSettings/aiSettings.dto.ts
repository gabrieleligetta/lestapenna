import { ApiProperty } from '@nestjs/swagger';
import type { AIProvider } from '../../config';
import type { AiPhase, AiTier } from '../../bard/ai/types';
import type { SecretVerifyStatus } from '../../db/repositories/TenantSecretsRepository';

/**
 * DTOs for a table's AI settings.
 *
 * Non-negotiable rule: **no response type has a field that contains a key**.
 * Of a credential we may say that it exists, how it ends (`hint`) and whether
 * the provider rejected it; the value never leaves — there is no `GET` that
 * returns it, and writing happens only via `PUT`.
 */

/**
 * The providers the UI offers.
 *
 * The criterion is that on their own they cover **the whole pipeline**, not
 * that they exist:
 *
 * | provider | transcription | text | embedding |
 * |---|---|---|---|
 * | `openai` | yes | yes | yes |
 * | `gemini` | yes | yes | yes |
 * | `ollama` | no, but the table's PC does | yes | yes |
 * | ~~`anthropic`~~ | **no** | yes | **no** (it has none) |
 * | ~~`ollama-cloud`~~ | **no** | yes | no |
 *
 * Anthropic and Ollama Cloud would vanish halfway through a session: neither
 * transcribes, and Anthropic does not even have an embedding model — the RAG
 * would stay mute. Offering them would mean letting a table configure itself
 * and then stop, and find out after recording.
 *
 * `ollama` stays because **it is not a key**: it is the table's own hardware,
 * and together with its PC for transcription it gives a complete flow at zero
 * cost. It is the free route, and removing it would remove the point of half
 * the project.
 *
 * The `AIProvider` type still contains all of them: a self-hoster can still
 * force them from `ai.config.json`, is assumed to know what they are doing, and
 * the readiness check will tell them it is not ready anyway.
 */
export const AI_PROVIDERS: AIProvider[] = ['openai', 'gemini', 'ollama'];

/** The ones that need a key. Ollama runs on the table's own hardware. */
export const KEYED_PROVIDERS: AIProvider[] = ['openai', 'gemini'];

export const AI_TIERS: AiTier[] = ['quality', 'fast'];

export class TierChoiceDto {
    @ApiProperty({ enum: AI_PROVIDERS })
    provider!: AIProvider;

    @ApiProperty({ description: 'Model id as the provider names it.' })
    model!: string;
}

export class PhaseConfigDto {
    @ApiProperty() phase!: AiPhase;
    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;
    @ApiProperty() model!: string;
    @ApiProperty({ nullable: true, enum: AI_TIERS, description: 'Which of the two groups drives this phase, when one does.' })
    tier!: AiTier | null;
}

export class CredentialStatusDto {
    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;

    @ApiProperty({ description: 'Vault key name, e.g. openai.apiKey.' })
    secret_key!: string;

    @ApiProperty({ description: 'Whether this table has stored a key for this provider.' })
    configured!: boolean;

    @ApiProperty({ nullable: true, description: 'Last 4 characters, to recognise which key it is. Never the key.' })
    hint!: string | null;

    @ApiProperty({ nullable: true, description: 'Outcome of the last real call or test.' })
    verify_status!: SecretVerifyStatus | null;

    @ApiProperty({ nullable: true }) verify_error!: string | null;
    @ApiProperty({ nullable: true }) last_verified_at!: number | null;
    @ApiProperty({ nullable: true }) updated_at!: number | null;
}

export class GuildAiSettingsDto {
    @ApiProperty({ description: 'Discord guild id these settings belong to.' })
    guild_id!: string;

    @ApiProperty({
        type: TierChoiceDto,
        nullable: true,
        description: 'Quality group: analyst and writer. Where the narrative quality of the summary is decided.',
    })
    quality!: TierChoiceDto | null;

    @ApiProperty({
        type: TierChoiceDto,
        nullable: true,
        description: 'Fast group: metadata, map, chat, narrative filter, reconciliation — and RAG.',
    })
    fast!: TierChoiceDto | null;

    /**
     * The model that draws entity portraits.
     *
     * It sits beside the two groups rather than inside them: it is not a text
     * model, it is never called by the session pipeline, and a table that never
     * asks for a picture never needs one. `null` means the instance default.
     */
    @ApiProperty({ type: TierChoiceDto, nullable: true })
    image!: TierChoiceDto | null;

    @ApiProperty({ type: [PhaseConfigDto], description: 'What every phase resolves to right now, groups expanded.' })
    effective!: PhaseConfigDto[];

    @ApiProperty({ type: [CredentialStatusDto], description: 'One entry per provider that needs a key.' })
    credentials!: CredentialStatusDto[];

    @ApiProperty({ description: 'False when a phase has no usable credential: nothing AI can start.' })
    ready!: boolean;

    @ApiProperty({ type: [String], enum: AI_PROVIDERS, description: 'Providers still missing a key.' })
    missing_providers!: AIProvider[];

    @ApiProperty({ description: 'Whether the caller may change keys and models. Everyone may look.' })
    can_manage!: boolean;
}

export class UpdateGuildAiSettingsDto {
    @ApiProperty({ type: TierChoiceDto, required: false, nullable: true, description: 'Null clears the choice and falls back to the instance defaults.' })
    quality?: TierChoiceDto | null;

    @ApiProperty({ type: TierChoiceDto, required: false, nullable: true })
    fast?: TierChoiceDto | null;

    @ApiProperty({ type: TierChoiceDto, required: false, nullable: true, description: 'The model that draws portraits. Null clears the choice.' })
    image?: TierChoiceDto | null;
}

export class PutCredentialDto {
    @ApiProperty({ description: 'The API key. Write-only: no endpoint ever returns it.' })
    api_key!: string;
}

export class CredentialTestResultDto {
    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;

    @ApiProperty({ enum: ['OK', 'AUTH_FAILED', 'QUOTA_EXHAUSTED', 'UNREACHABLE', 'UNDECRYPTABLE'] })
    status!: SecretVerifyStatus;

    @ApiProperty({ nullable: true, description: 'Provider message, trimmed. Never contains the key.' })
    detail!: string | null;

    @ApiProperty({ description: 'Model the probe used.' })
    model!: string;
}

/**
 * One entry of a model select.
 *
 * The rates travel as **numbers, not spelled into the label**: they used to be
 * concatenated into the help note, so the UI could only echo them back as they
 * came. Separate fields let it lay them out and align them, which is what makes
 * two models comparable at the moment of the choice rather than afterwards on
 * an invoice.
 *
 * `null` in a rate means we do not know it. It never means free — that is what
 * `runs_on_your_hardware` says.
 */
export class ModelOptionDto {
    @ApiProperty() id!: string;
    @ApiProperty({ nullable: true, description: 'Shown next to the name to help choose.' })
    label!: string | null;
    @ApiProperty({ description: 'True for the models we suggest for this group.' })
    recommended!: boolean;

    @ApiProperty({ nullable: true, description: 'USD per million input tokens. Null when unknown — not zero.' })
    input_per_million!: number | null;
    @ApiProperty({ nullable: true, description: 'USD per million output tokens.' })
    output_per_million!: number | null;
    @ApiProperty({ nullable: true, description: 'USD per minute of audio. Transcription models only.' })
    per_minute_usd!: number | null;
    @ApiProperty({ nullable: true, description: 'USD per generated picture. Image models only.' })
    per_image_usd!: number | null;
    @ApiProperty({ nullable: true, description: 'Context window, in tokens.' })
    context_tokens!: number | null;
    @ApiProperty({ description: 'Runs on the table\'s own hardware: no money, but time and electricity.' })
    runs_on_your_hardware!: boolean;
}

export class ProviderModelsDto {
    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;
    @ApiProperty({ type: [ModelOptionDto] }) quality!: ModelOptionDto[];
    @ApiProperty({ type: [ModelOptionDto] }) fast!: ModelOptionDto[];
    @ApiProperty({ type: [ModelOptionDto], description: 'Cloud models that turn audio into text.' })
    transcription!: ModelOptionDto[];
    @ApiProperty({ type: [ModelOptionDto], description: 'Models that draw entity portraits.' })
    image!: ModelOptionDto[];

    @ApiProperty({
        nullable: true,
        description: 'When the catalogue was last rebuilt. Null while it is still the curated list.',
    })
    refreshed_at!: number | null;
}

/**
 * The Whisper models installed on the table's own PC.
 *
 * `reason` rather than an error status: a home PC being off is its normal
 * state, not a failure of the settings page. The page has to be able to say
 * «switch it on to choose a model» instead of showing a red box.
 */
export class RemoteWhisperModelsDto {
    @ApiProperty({ type: [String], description: 'Model ids installed on that PC.' })
    models!: string[];

    @ApiProperty({ nullable: true, description: 'The one loaded right now.' })
    current!: string | null;

    @ApiProperty({
        nullable: true,
        enum: ['NOT_REMOTE', 'UNREACHABLE', 'UNAUTHORIZED'],
        description: 'Why the list is empty, when it is. Null when the PC answered.',
    })
    reason!: string | null;
}

export class WakeFieldDto {
    @ApiProperty() name!: string;
    @ApiProperty({ enum: ['text', 'password', 'number', 'url'] }) kind!: string;
    @ApiProperty() label!: string;
    @ApiProperty({ nullable: true }) hint!: string | null;
    @ApiProperty() required!: boolean;
    @ApiProperty({ nullable: true }) placeholder!: string | null;
    @ApiProperty({ description: 'Secrets go to the vault and never come back out.' })
    secret!: boolean;
}

/**
 * A wake method, with the fields it asks for.
 *
 * The UI draws the form from this and knows no router: adding a method means
 * adding one server-side file, without touching frontend or translations.
 */
export class WakeMethodDto {
    @ApiProperty() id!: string;
    @ApiProperty() label!: string;
    @ApiProperty() description!: string;
    @ApiProperty({ type: [WakeFieldDto] }) fields!: WakeFieldDto[];
}

export class WakeSettingsDto {
    @ApiProperty({ nullable: true, description: 'MAC of the PC. Without it there is nothing to wake.' })
    mac_address!: string | null;

    @ApiProperty({ description: 'Id of the wake method in use.' })
    method!: string;

    @ApiProperty({ type: Object, description: 'Values of the non-secret fields that method declares.' })
    options!: Record<string, string | number | undefined>;

    @ApiProperty({ type: [String], description: 'Names of the secret fields already stored. Never the values.' })
    configured_secrets!: string[];
}

export class WakeSettingsPatchDto {
    @ApiProperty({ required: false, nullable: true }) mac_address?: string | null;
    @ApiProperty({ required: false }) method?: string;
    @ApiProperty({ required: false, type: Object }) options?: Record<string, string | number | undefined>;
}

export class RemoteTranscriptionDto {
    @ApiProperty({ nullable: true, description: 'Base URL of the table\'s own machine running lesta-penna-ai-server.' })
    url!: string | null;

    @ApiProperty({
        nullable: true,
        description: 'Chosen model among those installed on it. Null leaves the choice to the PC.',
    })
    model!: string | null;

    @ApiProperty({ description: 'Whether an auth token is stored for it. Never the token.' })
    auth_token_configured!: boolean;

    @ApiProperty({ description: 'Ask the machine to shut down when a session ends. Opt-in: it is someone\'s home PC.' })
    shutdown_enabled!: boolean;

    @ApiProperty({ type: WakeSettingsDto }) wake!: WakeSettingsDto;
}

export class CloudTranscriptionDto {
    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;
    @ApiProperty() model!: string;
}

export class TranscriptionSettingsDto {
    @ApiProperty({
        nullable: true,
        enum: ['remote', 'cloud'],
        description: 'Own machine, or a cloud model billed to the table\'s key. Never both: no silent fallback from free to paid.',
    })
    engine!: 'remote' | 'cloud' | null;

    @ApiProperty({ type: RemoteTranscriptionDto }) remote!: RemoteTranscriptionDto;
    @ApiProperty({ type: CloudTranscriptionDto }) cloud!: CloudTranscriptionDto;

    @ApiProperty({ description: 'Whether the table can actually transcribe right now.' })
    usable!: boolean;

    @ApiProperty({ nullable: true, description: 'Why not, when it cannot.' })
    reason!: 'NOT_CONFIGURED' | 'NO_CLOUD_KEY' | null;

    @ApiProperty({ nullable: true, description: 'USD per minute of audio on the chosen cloud model. Null on own hardware, or unknown model.' })
    cloud_usd_per_minute!: number | null;
}

export class UpdateTranscriptionDto {
    @ApiProperty({ required: false, nullable: true, enum: ['remote', 'cloud'] })
    engine?: 'remote' | 'cloud' | null;

    @ApiProperty({ required: false, nullable: true }) remote_url?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        description: 'One of the models installed on that PC. Null leaves the choice to the PC.',
    })
    remote_model?: string | null;

    @ApiProperty({ required: false }) shutdown_enabled?: boolean;
    @ApiProperty({ required: false, type: WakeSettingsPatchDto }) wake?: WakeSettingsPatchDto;
    @ApiProperty({ required: false, enum: AI_PROVIDERS }) cloud_provider?: AIProvider;
    @ApiProperty({ required: false }) cloud_model?: string;
}

/**
 * A campaign's transcription choice.
 *
 * The engine is read-only here: picking between one's own PC and the cloud is
 * picking who pays, and that belongs to the guild. What a campaign moves is the
 * model.
 */
export class CampaignTranscriptionDto {
    @ApiProperty({ nullable: true, enum: ['remote', 'cloud'], description: 'Decided by the guild.' })
    engine!: 'remote' | 'cloud' | null;

    @ApiProperty({ nullable: true, description: 'Why the table cannot transcribe, when it cannot.' })
    reason!: 'NOT_CONFIGURED' | 'NO_CLOUD_KEY' | null;

    @ApiProperty({ nullable: true, description: 'The model this campaign will really use.' })
    effective_model!: string | null;

    @ApiProperty({ nullable: true, enum: AI_PROVIDERS, description: 'Only on the cloud engine.' })
    effective_provider!: AIProvider | null;

    @ApiProperty({ nullable: true, description: 'Cloud model chosen by this campaign. Null means it follows the guild.' })
    cloud_model!: string | null;

    @ApiProperty({ nullable: true, description: 'PC model chosen by this campaign. Null means it follows the guild.' })
    remote_model!: string | null;

    @ApiProperty({ nullable: true, description: 'USD per minute of audio. Null on own hardware, or unknown model.' })
    usd_per_minute!: number | null;
}

/**
 * What one phase would cost with a candidate model.
 *
 * `cost_usd` is `null` when the rate is unknown, and that is **not zero**: a
 * model released last week, or an id typed by hand, has a price we cannot state
 * — showing €0 would tell someone they are spending nothing while they spend.
 */
export class PhaseModelCostDto {
    @ApiProperty() phase!: AiPhase;
    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;
    @ApiProperty() model!: string;

    @ApiProperty({ description: 'Minutes of audio the estimate assumes.' })
    audio_minutes!: number;

    @ApiProperty() input_tokens!: number;
    @ApiProperty() output_tokens!: number;

    @ApiProperty({ nullable: true, description: 'Null when the rate is unknown. Never zero for "we do not know".' })
    cost_usd!: number | null;

    @ApiProperty({ nullable: true }) cost_eur!: number | null;

    @ApiProperty({ enum: ['builtin', 'tenant_override', 'free', 'subscription', 'unknown'] })
    pricing_source!: string;

    @ApiProperty({ description: 'True when the figure comes from this table\'s own past sessions.' })
    calibrated!: boolean;

    @ApiProperty({ description: 'Costs time and electricity rather than money.' })
    runs_on_your_hardware!: boolean;
}

export class UpdateCampaignTranscriptionDto {
    @ApiProperty({ required: false, nullable: true, description: 'Null clears the override and follows the guild.' })
    cloud_model?: string | null;

    @ApiProperty({ required: false, nullable: true })
    remote_model?: string | null;
}

export class PutWakeSecretDto {
    @ApiProperty({ description: 'Value of a secret field declared by the wake method. Write-only.' })
    value!: string;
}

export class TranscriptionProbeDto {
    @ApiProperty({ enum: ['OK', 'UNREACHABLE', 'UNAUTHORIZED', 'NOT_CONFIGURED'] })
    status!: 'OK' | 'UNREACHABLE' | 'UNAUTHORIZED' | 'NOT_CONFIGURED';

    @ApiProperty({ nullable: true }) detail!: string | null;
}

export class PhaseOverrideDto {
    @ApiProperty({ description: 'Phase to override, e.g. summary.' })
    phase!: AiPhase;

    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;
    @ApiProperty() model!: string;
}

export class UpdateCampaignPhasesDto {
    @ApiProperty({
        type: [PhaseOverrideDto],
        description: 'Full set of per-phase overrides for this campaign. An empty array clears them all.',
    })
    overrides!: PhaseOverrideDto[];
}

export class CampaignAiSettingsDto {
    @ApiProperty() campaign_id!: number;
    @ApiProperty() guild_id!: string;

    @ApiProperty({ type: [PhaseConfigDto], description: 'Read-only view of what this campaign actually uses.' })
    effective!: PhaseConfigDto[];

    @ApiProperty({ description: 'Whether the viewer can change the server keys and models.' })
    can_manage!: boolean;

    @ApiProperty({ description: 'False when a phase has no usable credential.' })
    ready!: boolean;

    @ApiProperty({
        type: [PhaseOverrideDto],
        description: 'Per-phase overrides set on this campaign. Models only: keys stay with the server.',
    })
    overrides!: PhaseOverrideDto[];

    @ApiProperty({
        description: 'Whether this campaign uses the semi-agentic summary pipeline instead of the linear one.',
    })
    agentic_summary!: boolean;
}

export class EmbeddingModelOptionDto {
    @ApiProperty() model!: string;
    @ApiProperty({ enum: AI_PROVIDERS }) provider!: AIProvider;
    @ApiProperty({ description: 'Vector length. Two different ones cannot be compared.' })
    dimension!: number;
    @ApiProperty({ description: 'USD per million tokens. Zero on the table\'s own hardware.' })
    usd_per_million_tokens!: number;
}

export class CampaignEmbeddingDto {
    @ApiProperty({ nullable: true, description: 'Model this campaign indexed with. Null before the first ingestion.' })
    model!: string | null;

    @ApiProperty({ nullable: true }) dimension!: number | null;
    @ApiProperty({ description: 'How many fragments are indexed right now.' })
    fragments!: number;

    @ApiProperty({ type: [EmbeddingModelOptionDto], description: 'What this table could switch to, given its keys and hardware.' })
    options!: EmbeddingModelOptionDto[];
}

export class ReindexEstimateDto {
    @ApiProperty() fragments!: number;
    @ApiProperty() current_model!: string;
    @ApiProperty() target_model!: string;
    @ApiProperty({ nullable: true, description: 'What re-embedding everything would cost on the table\'s account.' })
    estimated_usd!: number | null;
}

export class ReindexRequestDto {
    @ApiProperty({ description: 'Embedding model to switch to.' })
    model!: string;
}

export class ReindexResultDto {
    @ApiProperty() reindexed!: number;
    @ApiProperty({ description: 'Fragments left on the old model: invisible to search, not lost.' })
    failed!: number;
    @ApiProperty() model!: string;
}

export class PhaseCostEstimateDto {
    @ApiProperty() phase!: string;
    @ApiProperty() provider!: string;
    @ApiProperty() model!: string;
    @ApiProperty() input_tokens!: number;
    @ApiProperty() output_tokens!: number;
    @ApiProperty({ nullable: true, description: 'Null for phases billed per minute of audio rather than per token.' })
    input_per_million!: number | null;
    @ApiProperty({ nullable: true, description: 'Null for phases billed per minute of audio rather than per token.' })
    output_per_million!: number | null;
    @ApiProperty({ nullable: true, description: 'Null when we do not know the price. Not zero.' })
    cost_usd!: number | null;
    @ApiProperty({ enum: ['builtin', 'tenant_override', 'free', 'subscription', 'unknown'] })
    pricing_source!: string;
    @ApiProperty({ description: 'Runs on the table\'s own hardware: time and electricity, not money.' })
    resource_intensive!: boolean;
}

export class SessionCostEstimateDto {
    @ApiProperty() audio_minutes!: number;
    @ApiProperty({ type: [PhaseCostEstimateDto] }) per_phase!: PhaseCostEstimateDto[];
    @ApiProperty({ nullable: true }) total_usd!: number | null;
    @ApiProperty({ nullable: true }) total_eur!: number | null;
    @ApiProperty({ description: 'False when at least one phase has no known price: the total is partial.' })
    pricing_complete!: boolean;
    @ApiProperty({ type: [String] }) resource_intensive_phases!: string[];
    @ApiProperty({ description: 'True when calibrated on this table\'s own history rather than global defaults.' })
    calibrated!: boolean;
}

export class PricingOverrideDto {
    @ApiProperty({ description: 'Model id, or a prefix ending in *.' })
    model!: string;
    @ApiProperty() input_per_million!: number;
    @ApiProperty() output_per_million!: number;
    @ApiProperty({ required: false }) cached_input_per_million?: number;
    /**
     * USD per generated picture.
     *
     * Image models are billed per picture, and without this field the escape
     * hatch never reached them: the two per-token rates above describe a unit
     * they do not consume, so a table facing an unknown price on a portrait had
     * no way at all to declare what they actually pay.
     */
    @ApiProperty({ required: false }) per_image_usd?: number;
}

export class UpdatePricingOverridesDto {
    @ApiProperty({ type: [PricingOverrideDto], description: 'Full set. An empty array clears them.' })
    overrides!: PricingOverrideDto[];
}

export class UpdateCampaignFlowDto {
    @ApiProperty({ description: 'True for the semi-agentic pipeline, false for the linear one.' })
    agentic_summary!: boolean;
}
