/**
 * Shared `events` subcommand (`$npc events add <Name>`, `$quest events …`).
 *
 * This block (~50 lines: mode parsing, entity resolution, event config,
 * inline require of eventInteractive) used to be copy-pasted across
 * 9 entity commands with a `config: any` cast. It lives here once, with
 * static imports and real types.
 */

import { CommandContext } from '../types';
import { EntityEventsConfig } from './eventsViewer';
import { handleEventAdd, handleEventUpdate, handleEventDelete } from './eventInteractive';
import { MessageKey, t } from '../../i18n';
import { assertCampaignWrite } from './campaignWrite';

export type EventsMode = 'ADD' | 'UPDATE' | 'DELETE';

/** IT/EN aliases accepted for the event actions. */
const MODE_ALIASES: Record<string, EventsMode> = {
    add: 'ADD', crea: 'ADD',
    update: 'UPDATE', modifica: 'UPDATE',
    delete: 'DELETE', rimuovi: 'DELETE',
};

export interface ResolvedEventsEntity {
    /** Value for entityKeyColumn (usually the canonical name). */
    keyValue: string;
    displayName: string;
    secondaryKeyColumn?: string;
    secondaryKeyValue?: string;
    /** Override for the descriptor's emoji (e.g. an icon per faction type). */
    emoji?: string;
    /** Parent entity id (for the id-first match on histories with entity_id). */
    entityId?: number | null;
}

export interface EventsEntityDescriptor {
    /** History table, e.g. 'npc_history'. */
    tableName: string;
    /** Entity key column, e.g. 'npc_name'. */
    entityKeyColumn: string;
    emoji: string;
    /** i18n key of the entity label, for the error messages. */
    labelKey: MessageKey;
    /** Grammatical gender of the label (for participles/articles). Default 'm'. */
    gender?: 'm' | 'f';
    /** Resolves a name or short-id into the entity; null when not found. */
    resolve(campaignId: number, identifier: string): ResolvedEventsEntity | null;
    /** Interactive flows to start when the identifier is missing. */
    interactive?: Partial<Record<EventsMode, (ctx: CommandContext) => Promise<void>>>;
}

/**
 * Handles `events <add|update|delete> [identifier]`.
 * Returns true when the action was handled; false when `action` is not a
 * recognized mode (the caller carries on with the list/paginated view).
 */
export async function handleEventsAction(
    ctx: CommandContext,
    remainder: string[],
    descriptor: EventsEntityDescriptor
): Promise<boolean> {
    const action = remainder[0]?.toLowerCase();
    const mode = MODE_ALIASES[action];
    if (!mode) return false;

    // Every mode here is a write to the history: read-only does not go through
    // this function (it returns false above and continues into the viewer).
    if (!await assertCampaignWrite(ctx)) return true;

    const campaignId = ctx.activeCampaign!.id;
    const targetIdentifier = remainder.slice(1).join(' ').trim();

    // Without an identifier: the interactive selection flow (where provided)
    if (!targetIdentifier) {
        const interactive = descriptor.interactive?.[mode];
        if (interactive) {
            await interactive(ctx);
        } else {
            await ctx.message.reply(t(ctx.locale, 'events.specifyId', { action }));
        }
        return true;
    }

    const resolved = descriptor.resolve(campaignId, targetIdentifier);
    if (!resolved) {
        await ctx.message.reply(t(ctx.locale, descriptor.gender === 'f' ? 'crud.notFoundF' : 'crud.notFoundM', {
            label: t(ctx.locale, descriptor.labelKey),
            id: targetIdentifier,
        }));
        return true;
    }

    const config: EntityEventsConfig = {
        tableName: descriptor.tableName,
        entityKeyColumn: descriptor.entityKeyColumn,
        entityKeyValue: resolved.keyValue,
        campaignId,
        entityDisplayName: resolved.displayName,
        entityEmoji: resolved.emoji || descriptor.emoji,
        ...(resolved.entityId != null ? { entityId: resolved.entityId } : {}),
        ...(resolved.secondaryKeyColumn ? {
            secondaryKeyColumn: resolved.secondaryKeyColumn,
            secondaryKeyValue: resolved.secondaryKeyValue
        } : {})
    };

    if (mode === 'ADD') await handleEventAdd(ctx, config);
    else if (mode === 'UPDATE') await handleEventUpdate(ctx, config);
    else await handleEventDelete(ctx, config);

    return true;
}
