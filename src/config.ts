import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// AI PROVIDER TYPES (Exported for use in other modules)
// ============================================

export type AIProvider = 'openai' | 'gemini' | 'ollama';

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
        embedding: PhaseConfig;
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
    const localPath = path.resolve(process.cwd(), 'ai.config.local.json');

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

interface AIConfig {
    openAi: {
        apiKey: string;
        projectId: string;
    };
    gemini: {
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

interface RemoteWhisperConfig {
    url: string | null;
    timeout: number;
}

interface FeatureFlags {
    enableAiCorrection: boolean;
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
        developerId: getEnv('DISCORD_DEVELOPER_ID', false, '310865403066712074'),
        summaryChannelId: getEnv('DISCORD_SUMMARY_CHANNEL_ID'),
        commandChannelId: getEnv('DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID'),
        devGuildId: getEnv('DEV_GUILD_ID'),  // If set, bot only responds to this guild
        ignoreGuildIds: (() => {
            const envIds = (getEnv('IGNORE_GUILD_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
            const devGuildId = getEnv('DEV_GUILD_ID');
            // In prod (no DEV_GUILD_ID), always ignore the test server
            if (!devGuildId) {
                const TEST_SERVER_ID = '1458865478637322365';
                if (!envIds.includes(TEST_SERVER_ID)) {
                    envIds.push(TEST_SERVER_ID);
                }
            }
            return envIds;
        })()
    } as DiscordConfig,

    redis: {
        host: getEnv('REDIS_HOST', false, 'redis'),
        port: getInt('REDIS_PORT', 6379)
    } as RedisConfig,

    ai: {
        openAi: {
            apiKey: getEnv('OPENAI_API_KEY', false, 'dummy'),
            projectId: getEnv('OPENAI_PROJECT_ID'),
        },
        gemini: {
            apiKey: getEnv('GEMINI_API_KEY', false, 'dummy'),
        }
    } as AIConfig,

    smtp: {
        enabled: getBool('EMAIL_ENABLED', false),
        host: getEnv('SMTP_HOST', false, 'smtp.porkbun.com'),
        port: getInt('SMTP_PORT', 465),
        user: getEnv('SMTP_USER'),
        pass: getEnv('SMTP_PASS'),
        fromName: getEnv('SMTP_FROM_NAME', false, 'Lestapenna'),
        defaultRecipient: getEnv('REPORT_RECIPIENT', false, 'gabligetta@gmail.com')
    } as SMTPConfig,

    oci: {
        region: getEnv('OCI_REGION'),
        endpoint: getEnv('OCI_ENDPOINT'),
        accessKeyId: getEnv('OCI_ACCESS_KEY_ID'),
        secretAccessKey: getEnv('OCI_SECRET_ACCESS_KEY'),
        bucketName: getEnv('OCI_BUCKET_NAME')
    } as OCIConfig,

    remoteWhisper: {
        url: getEnv('REMOTE_WHISPER_URL') ? getEnv('REMOTE_WHISPER_URL').replace(/\/$/, '') : null,
        timeout: 2700000 // 45 min default
    } as RemoteWhisperConfig,

    features: _aiCfg.features as FeatureFlags
};
