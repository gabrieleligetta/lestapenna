import type { GuildAiSettings, TranscriptionSettings } from '../api/types';
import type { useT } from '../i18n';
import { providerName } from './aiLabels';


export type ChecklistState = 'done' | 'missing' | 'optional';

export interface ChecklistItem {
    id: string;
    label: string;
    detail: string;
    state: ChecklistState;
}

/**
 * What this table still needs before it can record.
 *
 * The settings page used to say it in one line — «this table cannot use AI yet:
 * a key is missing» — which is true and useless: it names one gap out of four
 * and points at nothing. The four are not interchangeable, and each has its own
 * remedy, so each gets its own row.
 *
 * Every figure here is already on the wire. `missing_providers` in particular
 * comes from `checkAiReadiness`, the same function `$listen` consults before
 * refusing to record, so the page and the bot cannot disagree.
 */
export function buildChecklist(
    t: ReturnType<typeof useT>,
    settings: GuildAiSettings,
    transcription: TranscriptionSettings | undefined,
    campaignCount: number | undefined,
): ChecklistItem[] {
    const items: ChecklistItem[] = [];

    // Not «is there any key», but «is there a key for the providers this table's
    // own configuration resolves to». A table entirely on its own hardware needs
    // none, and must not be told it is missing one.
    const missing = settings.missing_providers;
    items.push({
        id: 'keys',
        label: t.setup.checkKeys,
        detail: missing.length === 0
            ? t.setup.checkKeysDone
            : t.setup.checkKeysMissing(missing.map((provider) => providerName(t, provider)).join(', ')),
        state: missing.length === 0 ? 'done' : 'missing',
    });

    // Leaving both groups on the instance default is a legitimate choice, not a
    // gap: it is what a self-hosted instance with its own ai.config.json wants.
    const chosen = settings.quality !== null && settings.fast !== null;
    items.push({
        id: 'models',
        label: t.setup.checkModels,
        detail: chosen ? t.setup.checkModelsDone : t.setup.checkModelsDefault,
        state: chosen ? 'done' : 'optional',
    });

    items.push({
        id: 'transcription',
        label: t.setup.checkTranscription,
        detail: transcription?.usable
            ? t.setup.checkTranscriptionDone
            : transcription?.reason === 'NO_CLOUD_KEY'
                ? t.setup.checkTranscriptionNoKey
                : t.setup.checkTranscriptionMissing,
        state: transcription?.usable ? 'done' : 'missing',
    });

    items.push({
        id: 'campaign',
        label: t.setup.checkCampaign,
        detail: (campaignCount ?? 0) > 0 ? t.setup.checkCampaignDone : t.setup.checkCampaignMissing,
        state: (campaignCount ?? 0) > 0 ? 'done' : 'missing',
    });

    return items;
}
