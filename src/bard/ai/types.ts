import type { AIProvider } from '../../config';
import type { Secret } from '../../services/secretVault';

/**
 * Who an AI call's spend belongs to.
 *
 * The scope is the **guild**: it is the only one reachable from both entry
 * points — the Discord commands only know `interaction.guildId`, and the web app
 * resolves `campaign.guild_id` in the access guard. The `campaignId` travels
 * alongside for telemetry and for the future per-campaign override, but it is
 * never the one that decides which key pays.
 */
export interface AiScope {
    guildId: string;
    campaignId?: number;
}

export type AiPhase =
    | 'transcription'
    | 'metadata'
    | 'map'
    | 'analyst'
    | 'summary'
    | 'chat'
    | 'narrativeFilter'
    | 'reconcile'
    | 'embedding'
    | 'image';

/**
 * Every phase a session goes through, from transcription to RAG.
 *
 * Needed by the readiness check: a table that cannot complete one of these must
 * not be able to start recording.
 *
 * **`image` is deliberately absent.** Portrait generation is not part of a
 * session: it is asked for, one entity at a time, by someone looking at a sheet.
 * Listing it here would make a table unable to press "listen" until it had
 * configured an image model — refusing to record four hours of audio over a
 * feature that has nothing to do with recording.
 */
export const ALL_AI_PHASES: readonly AiPhase[] = [
    'transcription', 'metadata', 'map', 'analyst',
    'summary', 'chat', 'narrativeFilter', 'reconcile', 'embedding',
];

/**
 * The phases a user can trigger on demand, outside the session pipeline.
 *
 * Kept separate from `ALL_AI_PHASES` on purpose: these are optional, and their
 * absence must degrade one button rather than block recording. What they share
 * with the others is everything else — resolution, credentials, cost logging.
 */
export const ON_DEMAND_AI_PHASES: readonly AiPhase[] = ['image'];

/**
 * The two groups the user actually sees.
 *
 * Nine phases with independent providers and models are unmanageable for anyone
 * who does not know the pipeline: the UI exposes two, and the resolver expands
 * them into the phases. `embedding`, `transcription` and `image` stay out — they
 * are different model families, with constraints of their own, and have a
 * dedicated selection.
 */
export type AiTier = 'quality' | 'fast';

export const TIER_PHASES: Record<AiTier, AiPhase[]> = {
    // This is where the summary's narrative quality is decided.
    quality: ['analyst', 'summary'],
    // High volume, mechanical tasks. The RAG draws from here (it uses the `chat` phase).
    fast: ['metadata', 'map', 'chat', 'narrativeFilter', 'reconcile'],
};

export function tierOfPhase(phase: AiPhase): AiTier | null {
    if (TIER_PHASES.quality.includes(phase)) return 'quality';
    if (TIER_PHASES.fast.includes(phase)) return 'fast';
    return null; // embedding and transcription have a configuration of their own
}

/**
 * Credentials resolved for a call.
 *
 * `apiKey` is a `Secret`, not a string: it cannot end up in a log by oversight.
 * `source` distinguishes "configured" from "absent", which is what the UI has to
 * tell the table — the environment is no longer a possible origin.
 */
export interface ResolvedCredentials {
    provider: AIProvider;
    apiKey: Secret | null;
    baseUrl?: string;
    projectId?: string;
    source: 'tenant' | 'none';
    /** Identifies the credential so it can be flagged if the provider rejects it. */
    secretKey: string | null;
    scope: AiScope;
}

/**
 * The tenant has no usable credential for this phase.
 *
 * A typed error rather than a fake key: the old `'dummy'` default turned a
 * missing configuration into a provider authentication error, that is, into a
 * problem that looked like theirs and was in fact ours.
 */
export class AiNotConfiguredError extends Error {
    readonly code = 'AI_NOT_CONFIGURED';

    constructor(
        readonly phase: AiPhase,
        readonly provider: AIProvider,
        readonly missing: string,
        readonly scope: AiScope,
    ) {
        super(
            `Nessuna credenziale ${provider} configurata per la gilda ${scope.guildId} ` +
            `(fase ${phase}, manca ${missing}).`,
        );
        this.name = 'AiNotConfiguredError';
    }
}
