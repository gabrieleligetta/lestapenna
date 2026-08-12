import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// AI PROVIDER TYPES (Exported for use in other modules)
// ============================================

export type AIProvider = 'openai' | 'gemini' | 'ollama' | 'ollama-cloud' | 'anthropic';

export interface PhaseConfig {
    provider: AIProvider;
    model: string;
    localModel?: string;
}

export interface AiJsonConfig {
    phases: {
        transcription: PhaseConfig;
        metadata: PhaseConfig;
        map: PhaseConfig;
        analyst: PhaseConfig;
        summary: PhaseConfig;
        chat: PhaseConfig;
        narrativeFilter: PhaseConfig;
        reconcile?: PhaseConfig;
        embedding: PhaseConfig;
        /** Portrait generation. Optional: a table that never generates one needs no model here. */
        image?: PhaseConfig;
    };
    fallback: PhaseConfig;
    ollama: {
        remoteUrl: string;
        localUrl: string;
    };
    concurrency: Record<AIProvider, number>;
    chunkSize: Record<AIProvider, number>;
    chunkOverlap: Record<AIProvider, number>;
    features: {
        enableAiCorrection: boolean;
        enableAgenticSummary: boolean;
        narrativeBatchSize: number;
        narrativeOverlap: number;
    };
}

// ============================================
// AI CONFIG JSON LOADER (with deep-merge)
// ============================================

function deepMerge(base: unknown, override: unknown): unknown {
    if (
        typeof base !== 'object' || base === null ||
        typeof override !== 'object' || override === null
    ) {
        return override;
    }
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, val] of Object.entries(override as Record<string, unknown>)) {
        if (val !== null && val !== undefined) {
            if (
                typeof val === 'object' && !Array.isArray(val) &&
                typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
            ) {
                result[key] = deepMerge(result[key], val);
            } else {
                result[key] = val;
            }
        }
    }
    return result;
}

let _aiConfigCache: AiJsonConfig | null = null;

export function loadAiConfig(): AiJsonConfig {
    if (_aiConfigCache) return _aiConfigCache;

    const basePath = path.resolve(process.cwd(), 'ai.config.json');
    const localPath = path.resolve(process.cwd(), process.env.AI_CONFIG_LOCAL || 'ai.config.local.json');

    const base = JSON.parse(fs.readFileSync(basePath, 'utf-8')) as AiJsonConfig;

    if (!fs.existsSync(localPath)) {
        _aiConfigCache = base;
        return _aiConfigCache;
    }

    const local = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    _aiConfigCache = deepMerge(base, local) as AiJsonConfig;
    return _aiConfigCache;
}

// ============================================
// INTERFACES
// ============================================

interface DiscordConfig {
    token: string;
    developerId: string;
    summaryChannelId: string | null;
    commandChannelId: string | null;
    devGuildId: string | null;  // If set, bot only responds to this guild (for local dev)
    ignoreGuildIds: string[];   // Guilds to ignore (for prod to skip dev servers)
}

interface RedisConfig {
    host: string;
    port: number;
}

interface DiscordOAuthConfig {
    /** null when unconfigured: /auth/discord answers 503 instead of crashing the boot */
    clientId: string | null;
    clientSecret: string | null;
    /** Public origin of the site (used to build the default redirect_uri and links) */
    publicBaseUrl: string;
    redirectUri: string;
    /** Signs session cookies (@fastify/cookie); this is NOT the Discord token secret */
    sessionCookieSecret: string;
    /** TTL of the web session on the Redis side, in seconds (default 30 days) */
    sessionTtlSeconds: number;
}

/**
 * The links the bot points people at: the web app, the source, and the way to
 * support the project.
 *
 * They default to this project's own — the same ones already published in
 * .github/FUNDING.yml and the README — because `$dona` talks about Lestapenna,
 * not about whoever is hosting it. A fork that wants its own overrides them;
 * an instance that wants no nudges at all sets COMMUNITY_NUDGES=false, which
 * silences the automatic messages while leaving `$dona` available to anyone
 * who goes looking for it.
 */
interface LinksConfig {
    /** Empty disables the donation link everywhere, including in `$dona`. */
    donationUrl: string;
    /**
     * Whether that URL actually accepts money yet.
     *
     * A GitHub Sponsors profile that has not been published redirects to the
     * plain user page, so the link is reachable and asks for nothing — which is
     * worse than no link at all. False keeps the mention visible but inert, so
     * the surface can ship before the profile exists and be switched on later
     * from the environment alone.
     */
    donationActive: boolean;
    repoUrl: string;
    /** The web app: same origin as the OAuth callback. */
    webAppUrl: string;
    /** When false, only explicit `$dona` remains — no message ever volunteers it. */
    nudgesEnabled: boolean;
    /**
     * Where to write about privacy, reports and anything the bot cannot resolve
     * on its own. Discord's Developer Policy requires users have a way to report
     * issues, and §5(a) of the Terms requires the privacy contact to be
     * reachable from the application — both of which need an address that a
     * self-hoster can point at themselves rather than at the maintainer.
     */
    contactEmail: string;
}

interface AIConfig {
    openAi: {
        apiKey: string;
        projectId: string;
    };
    gemini: {
        apiKey: string;
    };
    ollamaCloud: {
        apiKey: string;
        baseUrl: string;
    };
    anthropic: {
        apiKey: string;
    };
}

interface SMTPConfig {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    pass: string;
    fromName: string;
    defaultRecipient: string;
}

interface OCIConfig {
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
}

export type MediaStorageDriver = 'disabled' | 'local' | 'oci';

interface MediaStorageConfig {
    driver: MediaStorageDriver;
    /** Separate from the recordings bucket by design. */
    bucketName: string | null;
    /** Used only by the explicit local driver, never in production. */
    localDirectory: string;
}

interface ReportsStorageConfig {
    /** Reports aggregate to the same OCI bucket from both local preview and prod. */
    driver: MediaStorageDriver;
    /** Reuses the private media bucket (lestapenna-media) unless overridden. */
    bucketName: string | null;
    /** Local fallback, only for tests or an explicit REPORTS_STORAGE_DRIVER=local. */
    localDirectory: string;
    /** 'prod' or 'local' — stored on each report so the agent/dev sees its origin. */
    origin: string;
}

interface FeatureFlags {
    enableAiCorrection: boolean;
    enableAgenticSummary: boolean;
    enableLocalStructuredPipeline?: boolean;
    narrativeBatchSize: number;
    narrativeOverlap: number;
}

// ============================================
// ENV HELPERS
// ============================================

const getEnv = (key: string, required: boolean = false, fallback: string = ''): string => {
    const value = process.env[key];
    if (!value && required) {
        throw new Error(`[Config] Missing required environment variable: ${key}`);
    }
    return value || fallback;
};

const getInt = (key: string, fallback: number): number => {
    const value = process.env[key];
    if (!value) return fallback;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? fallback : parsed;
};

const getBool = (key: string, fallback: boolean): boolean => {
    const value = process.env[key];
    if (!value) return fallback;
    return value.toLowerCase() === 'true';
};


// ============================================
// CONFIG EXPORT
// ============================================

const _aiCfg = loadAiConfig();

export const config = {
    discord: {
        token: getEnv('DISCORD_BOT_TOKEN', true),
        // No default: whoever sets this becomes an administrator of EVERY guild
        // the instance serves. An ID written in here would hand that person
        // the maintenance commands on every server of anyone who self-hosts,
        // without them noticing — and in a public repository a default like
        // that is not a convenience, it is a back door.
        // Empty means «nobody», and that is the right choice.
        developerId: getEnv('DISCORD_DEVELOPER_ID'),
        summaryChannelId: getEnv('DISCORD_SUMMARY_CHANNEL_ID'),
        commandChannelId: getEnv('DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID'),
        devGuildId: getEnv('DEV_GUILD_ID'),  // If set, bot only responds to this guild
        // Only what the instance declares. This used to also carry the ID of the
        // bot author's own test server, added automatically in production:
        // in a public repository that is someone else's server which every
        // installation silently ignores, and a real ID published for nothing.
        // Anyone with a test server lists it in their own IGNORE_GUILD_IDS.
        ignoreGuildIds: (getEnv('IGNORE_GUILD_IDS') || '')
            .split(',').map(s => s.trim()).filter(Boolean)
    } as DiscordConfig,

    redis: {
        host: getEnv('REDIS_HOST', false, 'redis'),
        port: getInt('REDIS_PORT', 6379)
    } as RedisConfig,

    discordOAuth: (() => {
        const publicBaseUrl = getEnv('PUBLIC_BASE_URL', false, 'https://lestapenna.quest').replace(/\/+$/, '');
        return {
            clientId: getEnv('DISCORD_CLIENT_ID') || null,
            clientSecret: getEnv('DISCORD_CLIENT_SECRET') || null,
            publicBaseUrl,
            redirectUri: getEnv('DISCORD_OAUTH_REDIRECT_URI') || `${publicBaseUrl}/api/v1/auth/discord/callback`,
            sessionCookieSecret: getEnv('SESSION_COOKIE_SECRET', false, 'dev-insecure-secret-change-me'),
            sessionTtlSeconds: getInt('WEB_SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
        };
    })() as DiscordOAuthConfig,

    links: (() => {
        const publicBaseUrl = getEnv('PUBLIC_BASE_URL', false, 'https://lestapenna.quest').replace(/\/+$/, '');
        return {
            donationUrl: getEnv('DONATION_URL', false, 'https://github.com/sponsors/gabrieleligetta'),
            donationActive: getBool('DONATION_ACTIVE', false),
            repoUrl: getEnv('REPO_URL', false, 'https://github.com/gabrieleligetta/lestapenna'),
            webAppUrl: publicBaseUrl,
            nudgesEnabled: getBool('COMMUNITY_NUDGES', true),
            contactEmail: getEnv('CONTACT_EMAIL', false, ''),
        };
    })() as LinksConfig,

    ai: {
        // INSTANCE keys, optional: under BYOK the normal source is the
        // per-table vault. Empty string rather than 'dummy' — a fake
        // placeholder travelled all the way to the provider and made a
        // configuration that was never done look like an auth error.
        openAi: {
            apiKey: getEnv('OPENAI_API_KEY', false, ''),
            projectId: getEnv('OPENAI_PROJECT_ID'),
        },
        gemini: {
            apiKey: getEnv('GEMINI_API_KEY', false, ''),
        },
        ollamaCloud: {
            apiKey: getEnv('OLLAMA_API_KEY', false, ''),
            baseUrl: getEnv('OLLAMA_CLOUD_BASE_URL', false, 'https://ollama.com/v1'),
        },
        anthropic: {
            apiKey: getEnv('ANTHROPIC_API_KEY', false, ''),
        }
    } as AIConfig,

    smtp: {
        enabled: getBool('EMAIL_ENABLED', false),
        host: getEnv('SMTP_HOST', false, 'smtp.porkbun.com'),
        port: getInt('SMTP_PORT', 465),
        user: getEnv('SMTP_USER'),
        pass: getEnv('SMTP_PASS'),
        fromName: getEnv('SMTP_FROM_NAME', false, 'Lestapenna'),
        // No default: an address written here would receive the reports of
        // anyone who does not configure one of their own.
        defaultRecipient: getEnv('REPORT_RECIPIENT')
    } as SMTPConfig,

    oci: {
        region: getEnv('OCI_REGION'),
        endpoint: getEnv('OCI_ENDPOINT'),
        accessKeyId: getEnv('OCI_ACCESS_KEY_ID'),
        secretAccessKey: getEnv('OCI_SECRET_ACCESS_KEY'),
        bucketName: getEnv('OCI_BUCKET_NAME')
    } as OCIConfig,

    mediaStorage: (() => {
        const rawDriver = getEnv(
            'MEDIA_STORAGE_DRIVER',
            false,
            process.env.NODE_ENV === 'test' ? 'local' : 'disabled',
        ).toLowerCase();
        if (!['disabled', 'local', 'oci'].includes(rawDriver)) {
            throw new Error('[Config] MEDIA_STORAGE_DRIVER must be disabled, local, or oci');
        }
        return {
            driver: rawDriver as MediaStorageDriver,
            bucketName: getEnv('OCI_MEDIA_BUCKET_NAME') || null,
            localDirectory: path.resolve(
                getEnv('MEDIA_LOCAL_DIR', false, path.join(process.cwd(), 'data', 'media')),
            ),
        };
    })() as MediaStorageConfig,

    reportsStorage: (() => {
        // Reports always target the real OCI bucket from both local preview and
        // production so the dev/agent reads them from one place; only the test
        // suite (or an explicit opt-in) falls back to a local directory.
        const rawDriver = getEnv(
            'REPORTS_STORAGE_DRIVER',
            false,
            process.env.NODE_ENV === 'test' ? 'local' : 'oci',
        ).toLowerCase();
        if (!['disabled', 'local', 'oci'].includes(rawDriver)) {
            throw new Error('[Config] REPORTS_STORAGE_DRIVER must be disabled, local, or oci');
        }
        return {
            driver: rawDriver as MediaStorageDriver,
            // OCI_REPORTS_BUCKET_NAME allows a future dedicated bucket without code change;
            // today reports live in the private media bucket under the reports/ prefix.
            bucketName: getEnv('OCI_REPORTS_BUCKET_NAME') || getEnv('OCI_MEDIA_BUCKET_NAME') || null,
            localDirectory: path.resolve(
                getEnv('REPORTS_LOCAL_DIR', false, path.join(process.cwd(), 'data', 'reports')),
            ),
            origin: getEnv('REPORTS_ORIGIN', false, process.env.NODE_ENV === 'production' ? 'prod' : 'local'),
        };
    })() as ReportsStorageConfig,

    features: _aiCfg.features as FeatureFlags,

    // Centralized local paths (overridable via env). The defaults replicate EXACTLY
    // the old __dirname-relative conventions scattered across recorder/sessionMixer/
    // summary (src/... in dev, dist/... in a build): no change of behaviour
    // without an explicit env var.
    paths: {
        recordingsDir: getEnv('RECORDINGS_DIR', false, path.join(__dirname, 'recordings')),
        mixedSessionsDir: getEnv('MIXED_SESSIONS_DIR', false, path.join(__dirname, 'mixed_sessions')),
        tempMixDir: getEnv('TEMP_MIX_DIR', false, path.join(__dirname, 'temp_mix')),
        transcriptsDir: getEnv('TRANSCRIPTS_DIR', false, path.join(__dirname, '..', 'transcripts')),
        audioDiagnosticsDir: getEnv('AUDIO_DIAGNOSTICS_DIR', false, path.join(__dirname, 'audio_diagnostics')),
    }
};
