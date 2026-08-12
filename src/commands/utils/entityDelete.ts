import {
    CrudEntityType,
    EntityDeleteBlockedError,
    EntityDeleteReport,
    asRow,
    deleteEntityCascade,
    purgeOrphanedMediaObjects,
} from '../../services/entityDeletion';
import { Locale, t } from '../../i18n';
import { CommandContext } from '../types';
import { assertCampaignWrite } from './campaignWrite';

export interface CommandDeleteResult {
    ok: boolean;
    report?: EntityDeleteReport;
    /** Set when the entity exists but cannot be deleted (the party faction). */
    blockedReason?: string;
    /** The caller is not part of the campaign: they have already been told why. */
    denied?: boolean;
}

/**
 * Cascade deletion as seen by the Discord commands.
 *
 * Every `$... delete` used to remove the entity row alone: the history was left
 * orphaned and the RAG card alive, so the Bardo kept answering about an NPC
 * that the list showed as deleted. Bot and web now go through the same
 * `deleteEntityCascade`, so they cannot diverge again.
 *
 * `row` arrives already resolved from the command (by name, short-id or
 * wizard): this function looks nothing up.
 *
 * The permission check lives here and not in the fourteen call sites: being the
 * only way to delete, a new delete cannot be born without a check by oversight.
 */
export async function deleteEntityFromCommand(
    ctx: CommandContext,
    entityType: CrudEntityType,
    /** The already resolved entity. Typed to the common minimum: the specs read the rest. */
    row: { id: number },
): Promise<CommandDeleteResult> {
    if (!await assertCampaignWrite(ctx)) return { ok: false, denied: true };

    const campaignId = ctx.activeCampaign!.id;
    try {
        const { report, mediaObjectKeys } = deleteEntityCascade(campaignId, entityType, asRow(row)!);
        // Objects on storage do not block the reply to the user: the entity is
        // already gone from the DB and a network error would only leave an orphan file.
        void purgeOrphanedMediaObjects(mediaObjectKeys).catch(() => undefined);
        return { ok: true, report };
    } catch (error) {
        if (error instanceof EntityDeleteBlockedError) {
            return { ok: false, blockedReason: error.message };
        }
        console.error(`[Delete] Cancellazione ${entityType} fallita:`, error);
        return { ok: false };
    }
}

/** Variant for `showWizardDeleteConfirmation`, which only wants a boolean. */
export async function deleteEntityForWizard(
    ctx: CommandContext,
    entityType: CrudEntityType,
    row: { id: number },
): Promise<boolean> {
    return (await deleteEntityFromCommand(ctx, entityType, row)).ok;
}

/**
 * Summary line to append to the confirmation message, or an empty string when
 * the cascade touched nothing else: whoever deletes must know that the history
 * and the Bardo's memory went too, not just the record.
 */
export function deleteSummaryLine(locale: Locale, report: EntityDeleteReport | undefined): string {
    if (!report) return '';
    const { history_deleted: history, rag_fragments_deleted: fragments } = report;
    if (history === 0 && fragments === 0) return '';
    return `\n${t(locale, 'crud.deleteSummary', { history: String(history), fragments: String(fragments) })}`;
}
