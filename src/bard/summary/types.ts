import { ToneKey } from '../types';

export interface SummaryPipelineContext {
    sessionId: string;
    tone: ToneKey;
    options: {
        skipAnalysis?: boolean;
        forceRegeneration?: boolean;
    };
    startAI: number;
    campaignId: number | null;
    castContext: string;
    playerCharacterNames: string[];
    fullDialogue: string;
    dynamicMemoryContext: string;
    worldManifesto: string;
    strictAgentic: boolean;
}
