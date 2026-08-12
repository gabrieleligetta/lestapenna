import type { AIProvider } from '../../config';
import { resolveCredentials } from './credentials';
import { getAiContext } from './resolver';
import { canTranscribe } from './transcription';
import { ALL_AI_PHASES, type AiPhase, type AiScope } from './types';

/**
 * Is a table ready to use AI?
 *
 * The question is asked **before** starting, not halfway through. Discovering a
 * missing key after recording two hours of session means having audio nobody
 * will be able to transcribe: the honest moment to say so is when "listen" is
 * pressed, when the only thing lost is a second.
 *
 * It does not touch the network: it resolves each phase's configuration and
 * looks at whether the corresponding credential exists in the vault. Whether the
 * key is valid and has credit is for the provider to say — that is only found
 * out by using it, and it is `providerErrors.ts`'s job.
 */

export interface MissingCredential {
    phase: AiPhase;
    provider: AIProvider;
    /** Name of the credential to configure, e.g. `openai.apiKey`. */
    secretKey: string;
}

export interface AiReadiness {
    ready: boolean;
    missing: MissingCredential[];
    /** The providers to configure, without repetitions: it is what the user is told. */
    providers: AIProvider[];
    /**
     * True if the table has a usable transcription engine.
     *
     * It is the hard prerequisite: without it, a recording is audio nobody will
     * be able to read. The other phases degrade, this one does not.
     */
    canTranscribe: boolean;
}

/**
 * Checks the given phases — by default all the ones a session goes through.
 *
 * Local Ollama always comes out ready: it runs on the table's own hardware and
 * has no credentials. Whether the node answers is another question, with another
 * answer (`isOllamaAlive`), because a switched-off PC can be switched on, a
 * missing key cannot.
 */
export function checkAiReadiness(scope: AiScope, phases: readonly AiPhase[] = ALL_AI_PHASES): AiReadiness {
    const ctx = getAiContext(scope);
    const missing: MissingCredential[] = [];

    for (const phase of phases) {
        // Transcription has no "phase key": it has an engine, and
        // `resolveTranscription` decides it. It is assessed separately, below.
        if (phase === 'transcription') continue;
        const { provider } = ctx.phaseConfig(phase);
        const creds = resolveCredentials(provider, scope);
        if (creds.source === 'none' && creds.secretKey) {
            missing.push({ phase, provider, secretKey: creds.secretKey });
        }
    }

    const transcription = canTranscribe(scope);

    return {
        ready: missing.length === 0 && transcription,
        missing,
        providers: [...new Set(missing.map(m => m.provider))],
        canTranscribe: transcription,
    };
}
