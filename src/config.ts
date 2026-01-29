import 'dotenv/config';

interface DiscordConfig {
    token: string;
    developerId: string;
    summaryChannelId: string | null;
    commandChannelId: string | null;
}

interface RedisConfig {
    host: string;
    port: number;
}

interface AIConfig {
    provider: 'openai' | 'ollama';
    openAi: {
        apiKey: string;
        projectId?: string;
        model: string;
        fallbackModel?: string;
    };
    ollama: {
        baseUrl: string;
        model: string;
    };
    embeddingProvider: 'openai' | 'ollama';

    // Granular Per-Phase Config
    phases: {
        transcription: { provider: 'openai' | 'ollama', model: string };
        metadata: { provider: 'openai' | 'ollama', model: string };
        map: { provider: 'openai' | 'ollama', model: string };
        summary: { provider: 'openai' | 'ollama', model: string };
        analyst: { provider: 'openai' | 'ollama', model: string };
        chat: { provider: 'openai' | 'ollama', model: string };
        narrativeFilter: { provider: 'openai' | 'ollama', model: string };
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

const getPhaseProvider = (phaseKey: string, fallbackKey: string = 'AI_PROVIDER'): 'openai' | 'ollama' => {
    const getVal = (key: string) => {
        const val = process.env[key] || '';
        // Strip everything after # and trim
        return val.split('#')[0].trim().toLowerCase();
    };

    // 1. Try specific provider (e.g. ANALYST_PROVIDER)
    const specific = getVal(`${phaseKey.toUpperCase()}_PROVIDER`);
    if (specific === 'openai' || specific === 'ollama') return specific as 'openai' | 'ollama';

    // 2. Try custom fallback (e.g. METADATA -> ANALYST)
    if (fallbackKey !== 'AI_PROVIDER') {
        const secondary = getVal(`${fallbackKey.toUpperCase()}_PROVIDER`);
        if (secondary === 'openai' || secondary === 'ollama') return secondary as 'openai' | 'ollama';
    }

    // 3. Global fallback
    const global = getVal('AI_PROVIDER');
    return global === 'ollama' ? 'ollama' : 'openai';
};

const getPhaseModel = (phaseKey: string, openAiFallback: string): string => {
    const val = (process.env[`OPEN_AI_MODEL_${phaseKey.toUpperCase()}`] || '').split('#')[0].trim();
    return val || openAiFallback;
};

const globalAiProvider = (() => {
    const p = (process.env['AI_PROVIDER'] || '').split('#')[0].trim().toLowerCase();
    return p === 'ollama' ? 'ollama' : 'openai';
})();

export const config = {
    discord: {
        token: getEnv('DISCORD_BOT_TOKEN', true),
        developerId: getEnv('DISCORD_DEVELOPER_ID', false, '310865403066712074'),
        summaryChannelId: getEnv('DISCORD_SUMMARY_CHANNEL_ID'),
        commandChannelId: getEnv('DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID')
    } as DiscordConfig,

    redis: {
        host: getEnv('REDIS_HOST', false, 'redis'),
        port: getInt('REDIS_PORT', 6379)
    } as RedisConfig,

    ai: {
        provider: globalAiProvider,
        openAi: {
            apiKey: getEnv('OPENAI_API_KEY', false, 'dummy'),
            projectId: getEnv('OPENAI_PROJECT_ID'),
            model: getEnv('OPEN_AI_MODEL', false, 'gpt-5-mini'),
            fallbackModel: getEnv('OPEN_AI_FALLBACK_MODEL', false, 'gpt-5-mini')
        },
        ollama: {
            baseUrl: getEnv('OLLAMA_BASE_URL', false, 'http://host.docker.internal:11434/v1'),
            model: getEnv('OLLAMA_MODEL', false, 'llama3.2')
        },
        embeddingProvider: getPhaseProvider('embedding'),

        phases: {
            transcription: {
                provider: getPhaseProvider('transcription'),
                model: getPhaseModel('transcription', 'gpt-5-mini')
            },
            metadata: {
                provider: getPhaseProvider('metadata'),
                model: getPhaseModel('metadata', 'gpt-5-mini')
            },
            map: {
                provider: getPhaseProvider('map'),
                model: getPhaseModel('map', 'gpt-5-mini')
            },
            summary: {
                provider: getPhaseProvider('summary'),
                model: getPhaseModel('summary', 'gpt-5-mini')
            },
            analyst: {
                provider: getPhaseProvider('analyst', 'metadata'),
                model: getPhaseModel('analyst', 'gpt-5-mini')
            },
            chat: {
                provider: getPhaseProvider('chat'),
                model: getPhaseModel('chat', 'gpt-5-mini')
            },
            narrativeFilter: {
                provider: getPhaseProvider('narrative_filter'),
                model: getPhaseModel('narrative_filter', 'gpt-5-mini')
            }
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
        timeout: 2700000 // 45 min defaults
    } as RemoteWhisperConfig,

    features: {
        enableAiCorrection: getEnv('ENABLE_AI_TRANSCRIPTION_CORRECTION') !== 'false',
        narrativeBatchSize: getInt('NARRATIVE_BATCH_SIZE', 30),
        narrativeOverlap: getInt('NARRATIVE_OVERLAP', 20)
    } as FeatureFlags
};

