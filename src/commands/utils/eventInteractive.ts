
import {
    MessageComponentInteraction,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ModalSubmitInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ComponentType,
    CollectorFilter
} from 'discord.js';
import { CommandContext } from '../types';
import {
    db,
    eventRepository,
    sessionRepository,
    markNpcDirty,
    markAtlasDirty,
    markInventoryDirty,
    markFactionDirty,
    markWorldEventDirty,
    markArtifactDirty,
    markQuestDirty,
    npcRepository,
    factionRepository
} from '../../db';
import { EntityEventsConfig, showEntityEvents, EVENT_TYPE_ICONS } from './eventsViewer';
import { Locale, t, eventTypeLabel } from '../../i18n';

// Helper to get event types based on table name
function getEventTypesForEntity(tableName: string): string[] {
    if (tableName === 'npc_history') {
        return ['ALLIANCE', 'BETRAYAL', 'DEATH', 'REVELATION', 'STATUS_CHANGE', 'NOTE'];
    } else if (tableName === 'character_history') {
        return ['GROWTH', 'TRAUMA', 'ACHIEVEMENT', 'GOAL_CHANGE', 'BACKGROUND', 'RELATIONSHIP', 'NOTE'];
    } else if (tableName === 'item_history' || tableName === 'artifact_history') {
        return ['LOOT', 'USE', 'TRADE', 'LOST', 'NOTE', 'DISCOVERY'];
    } else if (tableName === 'quest_history') {
        return ['PROGRESS', 'COMPLETE', 'FAIL', 'OPEN', 'CLOSED', 'NOTE'];
    } else if (tableName === 'bestiary_history') {
        return ['ENCOUNTER', 'KILL', 'NOTE'];
    } else if (tableName === 'location_history') {
        return ['VISIT', 'DISCOVERY', 'NOTE'];
    } else if (tableName === 'faction_history') {
        return ['REPUTATION_CHANGE', 'MEMBER_JOIN', 'MEMBER_LEAVE', 'NOTE'];
    }
    return ['NOTE', 'EVENT', 'UPDATE'];
}

/**
 * Helper to mark entity as dirty for RAG Sync based on table name
 */
function markEntityDirty(tableName: string, campaignId: number, entityValue: string) {
    try {
        if (tableName === 'npc_history') {
            markNpcDirty(campaignId, entityValue);
        } else if (tableName === 'location_history') {
            // location_history uses macro_location usually, but Atlas functions might need macro or both.
            // EntityKeyValue for Atlas in these configs is usually "Macro - Micro" or just Macro depending on setup.
            // BUT `atlas.ts` config sets `entityKeyColumn: 'macro_location', entityKeyValue: entry.macro_location`
            // AND `secondaryKeyColumn: 'micro_location', secondaryKeyValue: entry.micro_location`
            // markAtlasDirty needs (campaignId, macro, micro).
            // We need access to secondary value if available.
            // This helper receives `entityValue` which matches `entityKeyValue` from config.
            // For Atlas, that's Macro Location.
            // We need to fetch the config context or pass it in.
            // Let's refactor this to take the whole config object.
        }
    } catch (e) {
        console.error(`Error marking dirty for ${tableName}:`, e);
    }
}

/**
 * Marks an entity as dirty based on configuration
 */
function markDirtyByConfig(config: EntityEventsConfig) {
    try {
        if (config.tableName === 'npc_history') {
            markNpcDirty(config.campaignId, config.entityKeyValue);
        } else if (config.tableName === 'location_history') {
            // Atlas requires Macro + Micro
            if (config.secondaryKeyValue) {
                markAtlasDirty(config.campaignId, config.entityKeyValue, config.secondaryKeyValue);
            }
        } else if (config.tableName === 'item_history' || config.tableName === 'inventory_history') {
            markInventoryDirty(config.campaignId, config.entityKeyValue);
        } else if (config.tableName === 'artifact_history') {
            // Artifacts usually share item_history but if separate table:
            markArtifactDirty(config.campaignId, config.entityKeyValue);
        } else if (config.tableName === 'faction_history') {
            markFactionDirty(config.campaignId, config.entityKeyValue);
        } else if (config.tableName === 'quest_history') {
            markQuestDirty(config.campaignId, config.entityKeyValue);
        } else if (config.tableName === 'world_history') {
            // Handled by EventRepository
        }
        // Character history sync is complex, often manual or strictly session based.
    } catch (e) {
        console.error(`[EventInteractive] Failed to mark dirty:`, e);
    }
}

/**
 * Handles the main `$entity events` command routing
 */
export async function handleEntityEventsCommand(ctx: CommandContext, config: EntityEventsConfig) {
    const subCommand = ctx.args[0]?.toLowerCase(); // 'events'
    const action = ctx.args[1]?.toLowerCase(); // 'add', 'update', 'delete', or target

    // If "events" is the first arg, shift args to handle "events add ..." vs "events <name>"
    // ACTUALLY: The caller usually strips the main command. 
    // If command is `$npc events add ...`, args might be ['events', 'add', ...] depending on how caller handles it.
    // Let's assume the caller passes the FULL args list starting after `$npc`.

    // BUT checking existing code:
    // `const remainder = ctx.args.slice(1);` inside `if (subCommand === 'events')`

    // So we should be called with `remainder` as args effectively, OR we handle the parsing here if we replace the whole block.
    // Let's assume this function replaces the INSIDE of `if (subCommand === 'events')`.
    // So `ctx.args` here are `['add', ...]` or `['list']` or `['<name>']`.

    // Wait, the caller passes `ctx`. If we call this from `npcCommand`, `ctx.args` is still the original full args.
    // We need to parse robustly.

    // Find where 'events' is in args
    const eventsIndex = ctx.args.findIndex(a => a.toLowerCase() === 'events' || a.toLowerCase() === 'eventi');
    if (eventsIndex === -1) return; // Should not happen if called correctly

    const eventsArgs = ctx.args.slice(eventsIndex + 1);
    const firstEventArg = eventsArgs[0]?.toLowerCase();

    if (firstEventArg === 'add' || firstEventArg === 'aggiungi') {
        await handleEventAdd(ctx, config, eventsArgs.slice(1).join(' '));
        return;
    }

    if (firstEventArg === 'update' || firstEventArg === 'modifica') {
        await handleEventUpdate(ctx, config, eventsArgs.slice(1).join(' '));
        return;
    }

    if (firstEventArg === 'delete' || firstEventArg === 'rimuovi' || firstEventArg === 'del') {
        await handleEventDelete(ctx, config, eventsArgs.slice(1).join(' '));
        return;
    }

    // Default: List/View
    // Check if user provided a specific target "events <name> [page]"
    const target = eventsArgs.join(' ').trim();

    // If no target or 'list', interactive list
    if (!target || target === 'list' || target === 'lista') {
        await startEventsInteractiveList(ctx, config);
        return;
    }

    // Attempt to parse page number from end
    let page = 1;
    let explicitTarget = target;
    const lastArg = eventsArgs[eventsArgs.length - 1];
    if (eventsArgs.length > 1 && !isNaN(parseInt(lastArg))) {
        page = parseInt(lastArg);
        explicitTarget = eventsArgs.slice(0, -1).join(' ');
    }

    // In this generic handler, we might need a way to Resolve the entity ID from name if needed.
    // BUT `showEntityEvents` takes `entityKeyValue` which is usually the name.
    // So we just pass the name.

    // However, if the user types `$npc events #abcde`, we might want to resolve it.
    // The `config` passed in usually has the resolved entity info IF the context was already resolving it using `config`.
    // BUT `config` is static passed from the command usually?
    // No, usually `showEntityEvents` is called AFTER resolving the entity.

    // So `handleEntityEventsCommand` needs to do the resolution?
    // Or we leave the resolution to the caller and just provide the interactive sub-handlers?

    // Let's Refactor:
    // This file will export `handleEventAdd`, `handleEventUpdate`, `handleEventDelete`.
    // The main routing logic might be best kept in the command file OR we need a `resolveEntity` callback.

    // Let's stick to implementing the specific handlers for now, and a helper for the list.
}

/**
 * Interactive ADD Event
 */
export async function handleEventAdd(ctx: CommandContext, config: EntityEventsConfig, preFilledContent?: string) {
    // Step 1: Select Session
    const sessions = sessionRepository.getAvailableSessions(ctx.guildId, config.campaignId, 25);

    // If no sessions, or user wants manual entry, we can offer "No Session / Manual" option.

    if (sessions.length === 0) {
        // Skip selection, go to modal
        await showAddModal(ctx, config, 'UNKNOWN_SESSION', preFilledContent);
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('select_session_add_event')
        .setPlaceholder(t(ctx.locale, 'events.sessionSelectPlaceholder'))
        .addOptions([
            new StringSelectMenuOptionBuilder()
                .setLabel(t(ctx.locale, 'events.noSessionLabel'))
                .setDescription(t(ctx.locale, 'events.noSessionDesc'))
                .setValue('UNKNOWN_SESSION')
                .setEmoji('🚫'),
            ...sessions.map((s: any) => {
                const date = new Date(s.start_time).toLocaleDateString();
                return new StringSelectMenuOptionBuilder()
                    .setLabel(t(ctx.locale, 'events.sessionOptionLabel', { n: s.session_number, title: s.title || t(ctx.locale, 'events.untitled') }))
                    .setDescription(t(ctx.locale, 'events.sessionOptionDesc', { date, id: s.session_id }))
                    .setValue(s.session_id)
                    .setEmoji('🎬');
            })
        ]);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'events.pickSession'),
        components: [row]
    });

    // Create collector
    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: i => i.customId === 'select_session_add_event' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        if (i.user.id !== ctx.message.author.id) {
            await i.reply({ content: t(ctx.locale, 'events.unauthorized'), ephemeral: true });
            return;
        }

        // Stop this collector so it doesn't process subsequent interactions (like Type Selection)
        collector.stop('selected');

        const sessionId = i.values[0];

        // Step 2: Select Event Type
        await showTypeSelection(i, config, sessionId, 'ADD', preFilledContent, undefined, ctx.locale);

        // Do NOT delete `reply` here, as showTypeSelection updates it.
    });

    collector.on('end', (collected: any, reason: any) => {
        if (reason === 'time' && collected.size === 0) {
            reply.edit({ content: t(ctx.locale, 'crud.selectionTimeout'), components: [] }).catch(() => { });
        }
    });
}

// Step 2: Type Selection
async function showTypeSelection(interaction: any, config: EntityEventsConfig, sessionId: string, mode: 'ADD' | 'UPDATE', preFilledContent?: string, eventId?: number, locale: Locale = 'en') {
    const types = getEventTypesForEntity(config.tableName);

    const select = new StringSelectMenuBuilder()
        .setCustomId(`select_type_${mode}`)
        .setPlaceholder(t(locale, 'events.typePlaceholder'))
        .addOptions(types.map(type => {
            const icon = EVENT_TYPE_ICONS[type] || '📋';
            return new StringSelectMenuOptionBuilder()
                .setLabel(eventTypeLabel(locale, type))
                .setValue(type)
                .setEmoji(icon);
        }));

    // Add "Custom / Manual" option
    select.addOptions(new StringSelectMenuOptionBuilder()
        .setLabel(t(locale, 'events.otherManual'))
        .setValue('MANUAL')
        .setEmoji('✏️')
    );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const content = t(locale, mode === 'ADD' ? 'events.typePromptAdd' : 'events.typePromptEdit');

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
    }

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && (i.customId === `select_type_${mode}`)
    });

    collector.on('collect', async (i: any) => {
        collector.stop('selected');
        const selectedType = i.values[0];

        if (mode === 'ADD') {
            await showAddModal_Final(i, config, sessionId, selectedType, preFilledContent, locale);
        } else {
            // Update flow - show modal with pre-filled stuff
            await showEditModal_Final(i, config, eventId!, selectedType, preFilledContent || "", sessionId, locale);
        }
    });
}

// Final Step: Modal for Description (Add)
async function showAddModal_Final(interaction: any, config: EntityEventsConfig, sessionId: string, eventType: string, preFilledContent?: string, locale: Locale = 'en') {
    // Encode session, type and timestamp in the modal ID for stateless handling
    const safeType = eventType.substring(0, 20);
    const modalId = `ev_add|${sessionId}|${safeType}|${Date.now()}`;

    const baseTitle = t(locale, 'events.addModalTitle', { name: config.entityDisplayName, session: sessionId === 'UNKNOWN_SESSION' ? 'No' : sessionId });
    const title = baseTitle.length > 45 ? baseTitle.substring(0, 42) + '...' : baseTitle;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    const descInput = new TextInputBuilder()
        .setCustomId('event_description')
        .setLabel(t(locale, 'events.modalDescLabel'))
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder(t(locale, 'events.modalDescPlaceholder'))
        .setRequired(true);

    if (preFilledContent) descInput.setValue(preFilledContent.slice(0, 4000));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(descInput));

    // Optional Alignment Fields for NPC/Faction
    if (config.tableName === 'npc_history' || config.tableName === 'faction_history') {
        const moralInput = new TextInputBuilder()
            .setCustomId('moral_weight')
            .setLabel(t(locale, 'events.moralLabel'))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(t(locale, 'events.moralPlaceholder'))
            .setRequired(false);

        const ethicalInput = new TextInputBuilder()
            .setCustomId('ethical_weight')
            .setLabel(t(locale, 'events.ethicalLabel'))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(t(locale, 'events.ethicalPlaceholder'))
            .setRequired(false);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(moralInput));
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(ethicalInput));
    }

    await interaction.showModal(modal);
    await handleModalSubmit(interaction, config, modalId, 'ADD', undefined, locale);
}

// Fallback helper for text-only invocation if needed (but currently we force flow via select mainly)
async function showAddModal(ctx: CommandContext, config: EntityEventsConfig, sessionId: string, preFilledContent?: string) {
    // This needs a button trigger if not interaction based
    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('open_event_add_modal_fb')
            .setLabel(t(ctx.locale, 'events.fillDetailsBtn'))
            .setStyle(ButtonStyle.Success)
    );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'events.addPrompt', { name: config.entityDisplayName, session: sessionId }),
        components: [btnRow]
    });

    try {
        const interaction = await reply.awaitMessageComponent({
            filter: i => i.user.id === ctx.message.author.id && i.customId === 'open_event_add_modal_fb',
            time: 60000
        });

        // Jump to Type Selection
        await showTypeSelection(interaction, config, sessionId, 'ADD', preFilledContent, undefined, ctx.locale);

        await reply.delete().catch(() => { });
    } catch (e) {
        await reply.edit({ content: t(ctx.locale, 'events.timeout'), components: [] });
    }
}


async function handleModalSubmit(interaction: MessageComponentInteraction, config: EntityEventsConfig, modalId: string, mode: 'ADD' | 'UPDATE', eventId?: number, locale: Locale = 'en') {
    const filter = (i: ModalSubmitInteraction) => i.customId === modalId && i.user.id === interaction.user.id;
    try {
        const submission = await interaction.awaitModalSubmit({ filter, time: 300000 });

        const description = submission.fields.getTextInputValue('event_description');

        // Extract Session and Type from Modal ID for ADD
        // Encode format: ev_add|sessionId|type|timestamp
        let session: string | undefined;
        let type: string | undefined;

        if (mode === 'ADD') {
            const parts = modalId.split('|');
            if (parts.length >= 3) {
                session = parts[1];
                type = parts[2];
            }
        } else {
            // UPDATE: id is ev_upd|id|type|session|ts
            const parts = modalId.split('|');
            if (parts.length >= 4) {
                // eventId is passed as arg, but let's trust arg
                type = parts[2];
                session = parts[3];
            }
        }

        if (session === 'UNKNOWN_SESSION' || session === 'undefined') session = undefined;

        if (mode === 'ADD') {
            // Check for weights
            let moralWeight = 0;
            let ethicalWeight = 0;
            if (config.tableName === 'npc_history' || config.tableName === 'faction_history') {
                try {
                    const mVal = submission.fields.getTextInputValue('moral_weight');
                    const eVal = submission.fields.getTextInputValue('ethical_weight');
                    if (mVal) moralWeight = parseInt(mVal) || 0;
                    if (eVal) ethicalWeight = parseInt(eVal) || 0;
                } catch (e) { }
            }

            if (config.tableName === 'npc_history') {
                // Use specific repo for live updates
                npcRepository.addNpcEvent(
                    config.campaignId,
                    config.entityKeyValue, // name
                    session || null as any, // fix type mismatch if needed, usually string|null
                    description,
                    type || 'NOTE',
                    true, // manual
                    undefined,
                    moralWeight,
                    ethicalWeight
                );
            } else if (config.tableName === 'faction_history') {
                // Use specific repo
                factionRepository.addFactionEvent(
                    config.campaignId,
                    config.entityKeyValue,
                    session || null,
                    description,
                    type || 'NOTE' as any,
                    true, // manual 
                    0, // rep change (handled separately or 0)
                    moralWeight,
                    ethicalWeight
                );
            } else {
                // Generic fallback
                eventRepository.addEvent(
                    config.tableName,
                    config.entityKeyColumn,
                    config.entityKeyValue,
                    config.campaignId,
                    description,
                    type || 'NOTE',
                    session,
                    undefined, // timestamp
                    config.secondaryKeyColumn,
                    config.secondaryKeyValue
                );
            }

            await submission.reply({ content: t(locale, 'events.added', { name: config.entityDisplayName }), ephemeral: false });
        } else if (mode === 'UPDATE' && eventId) {
            eventRepository.updateEvent(config.tableName, eventId, description, session, type);
            await submission.reply({ content: t(locale, 'events.updated'), ephemeral: false });
        }

        // Mark Dirty for RAG Sync
        markDirtyByConfig(config);

    } catch (e) {
        console.error("Modal error", e);
    }
}

/**
 * Interactive UPDATE Event
 */
export async function handleEventUpdate(ctx: CommandContext, config: EntityEventsConfig, args?: string) {
    // 1. If ID provided, direct edit
    if (args && !isNaN(parseInt(args))) {
        const eventId = parseInt(args);
        const event = eventRepository.getEventById(config.tableName, eventId);

        if (!event) {
            await ctx.message.reply(t(ctx.locale, 'events.idNotFound', { id: eventId }));
            return;
        }

        await showEditModal(ctx, config, event);
        return;
    }

    // 2. Else, Interactive Selection from List
    await startEventSelectionFlow(ctx, config, 'UPDATE');
}

/**
 * Interactive DELETE Event
 */
export async function handleEventDelete(ctx: CommandContext, config: EntityEventsConfig, args?: string) {
    // 1. If ID provided, confirm and delete
    if (args && !isNaN(parseInt(args))) {
        const eventId = parseInt(args);
        const event = eventRepository.getEventById(config.tableName, eventId);

        if (!event) {
            await ctx.message.reply(t(ctx.locale, 'events.idNotFound', { id: eventId }));
            return;
        }

        await confirmAndDelete(ctx, config, event);
        return;
    }

    // 2. Else, Interactive Selection
    await startEventSelectionFlow(ctx, config, 'DELETE');
}

// --- Helpers ---

// Show EDIT Options (Type Select)
async function showEditModal(ctx: CommandContext, config: EntityEventsConfig, event: any) {
    // We reuse showTypeSelection logic
    // Just create a dummy interaction or something?
    // Start with a reply with button to Edit

    // Actually, we can just call showTypeSelection directly if we have an interaction.
    // If we came from Command line ($npc events update ID), we reply first.

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`trigger_edit_${event.id}`)
            .setLabel(t(ctx.locale, 'events.editBtn', { id: event.id }))
            .setStyle(ButtonStyle.Primary)
    );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'events.editPrompt', { id: event.id }),
        components: [row]
    });

    try {
        const interaction = await reply.awaitMessageComponent({
            filter: i => i.user.id === ctx.message.author.id && i.customId === `trigger_edit_${event.id}`,
            time: 60000
        });

        // Go to Type Selection
        // Pre-fill content is description.
        await showTypeSelection(interaction, config, event.session_id || 'UNKNOWN_SESSION', 'UPDATE', event.description, event.id, ctx.locale);

        await reply.delete().catch(() => { });

    } catch (e) {
        await reply.edit({ content: t(ctx.locale, 'events.timeout'), components: [] });
    }
}

async function showEditModal_Final(interaction: any, config: EntityEventsConfig, eventId: number, type: string, description: string, session: string, locale: Locale = 'en') {
    const safeType = type.substring(0, 20);
    // Encode UPDATE: ev_upd|id|type|session|ts
    const modalId = `ev_upd|${eventId}|${safeType}|${session}|${Date.now()}`;

    const baseTitle = t(locale, 'events.editModalTitle', { id: eventId });
    const title = baseTitle.length > 45 ? baseTitle.substring(0, 42) + '...' : baseTitle;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    const descInput = new TextInputBuilder()
        .setCustomId('event_description')
        .setLabel(t(locale, 'events.editDescLabel'))
        .setStyle(TextInputStyle.Paragraph)
        .setValue(description)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(descInput));

    await interaction.showModal(modal);
    await handleModalSubmit(interaction, config, modalId, 'UPDATE', eventId, locale);
}

async function startEventSelectionFlow(ctx: CommandContext, config: EntityEventsConfig, mode: 'UPDATE' | 'DELETE') {
    // Fetch last 25 events
    const query = `
        SELECT id, description, event_type, session_id, timestamp 
        FROM ${config.tableName} 
        WHERE campaign_id = ? AND LOWER(${config.entityKeyColumn}) = LOWER(?)
        ORDER BY COALESCE(timestamp, 0) DESC, id DESC
        LIMIT 25
    `;
    const events = db.prepare(query).all(config.campaignId, config.entityKeyValue) as any[];

    if (events.length === 0) {
        await ctx.message.reply(t(ctx.locale, 'events.noneForEntity', { name: config.entityDisplayName }));
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(`select_event_${mode}`)
        .setPlaceholder(t(ctx.locale, mode === 'UPDATE' ? 'events.pickPlaceholderUpdate' : 'events.pickPlaceholderDelete'))
        .addOptions(events.map(e => {
            const desc = e.description.substring(0, 50);
            return new StringSelectMenuOptionBuilder()
                .setLabel(`#${e.id} - ${eventTypeLabel(ctx.locale, e.event_type)}`)
                .setDescription(`${e.session_id ? `[S${e.session_id}] ` : ''}${desc}...`)
                .setValue(e.id.toString())
        }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const reply = await ctx.message.reply({
        content: t(ctx.locale, mode === 'UPDATE' ? 'events.pickPromptUpdate' : 'events.pickPromptDelete'),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: i => i.user.id === ctx.message.author.id && i.customId === `select_event_${mode}`
    });

    collector.on('collect', async (i) => {
        if (i.user.id !== ctx.message.author.id) {
            await i.reply({ content: t(ctx.locale, 'events.unauthorized'), ephemeral: true });
            return;
        }

        const eventId = parseInt(i.values[0]);
        const event = events.find(e => e.id === eventId);

        if (!event) {
            await i.reply({ content: t(ctx.locale, 'events.errNotFound'), ephemeral: true });
            return;
        }

        if (mode === 'UPDATE') {
            collector.stop('selected');
            // Update Flow
            // Pass interaction directly to showTypeSelection to update the menu in-place
            // Note: showTypeSelection will handle update/editReply.
            await showTypeSelection(i, config, event.session_id || 'UNKNOWN_SESSION', 'UPDATE', event.description, event.id);
        } else {
            // DELETE
            await i.deferUpdate();
            await reply.delete().catch(() => { });
            await confirmAndDelete(ctx, config, event);
        }
    });
}

async function confirmAndDelete(ctx: CommandContext, config: EntityEventsConfig, event: any) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('confirm_del').setLabel(t(ctx.locale, 'events.confirmDeleteBtn')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel_del').setLabel(t(ctx.locale, 'common.cancel')).setStyle(ButtonStyle.Secondary)
    );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'events.confirmDelete', { id: event.id, desc: event.description }),
        components: [row]
    });

    try {
        const i = await reply.awaitMessageComponent({
            filter: i => i.user.id === ctx.message.author.id,
            time: 30000
        });

        if (i.customId === 'confirm_del') {
            eventRepository.deleteEvent(config.tableName, event.id);
            await i.update({ content: t(ctx.locale, 'events.deleted'), components: [] });

            // Mark Dirty for RAG Sync
            markDirtyByConfig(config);
        } else {
            await i.update({ content: t(ctx.locale, 'events.opCancelled'), components: [] });
        }
    } catch {
        await reply.edit({ content: t(ctx.locale, 'events.timeout'), components: [] });
    }
}

/**
 * Interactive List with ADD button + Select for Details
 * Wrapper around showEntityEvents but adds "Add Event" button
 */
export async function startEventsInteractiveList(ctx: CommandContext, config: EntityEventsConfig) {
    // Since we can't easily inject buttons into `showEntityEvents` without refactoring it heavily,
    // we can send a separate message OR we assume the user will use explicit commands if they don't see buttons.
    // BUT the requirement is interactive.

    // Strategy: Call `showEntityEvents` normally.
    // THEN send a follow-up action bar? Or rely on `showEntityEvents` to handle display.

    // Better: let's modifying `showEntityEvents` to accept extra components?
    // Or just provide a simple menu here:

    await showEntityEvents(ctx, config, 1);

    // Add "Add Event" shortcut?
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('trigger_add_event')
            .setLabel(t(ctx.locale, 'events.addEventBtn'))
            .setStyle(ButtonStyle.Success)
    );

    const msg = await (ctx.message.channel as any).send({ components: [row] });

    try {
        const i = await msg.awaitMessageComponent({
            filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'trigger_add_event',
            time: 60000
        });

        // await msg.delete().catch(() => { });
        // We can't use `showModal` on a message component from a *different* interaction easily if we want to chain it 
        // properly without "This interaction has already been acknowledged".
        // But here we just caught the button click. We MUST show modal on THIS interaction.

        // Quick Add Flow
        // 1. Session? Defaults to UNKNOWN or we ask? 
        // Quick add usually implies fast entry. Let's ask session or default to None if "Quick" is truly quick.
        // But code re-use: `handleEventAdd` asks session.
        // Let's just call `handleEventAdd` logic but starting from button click?

        // Actually `startEventsInteractiveList` adds a button.
        // Upon click, we have an interaction.
        // We can just call `showTypeSelection` with UNKNOWN_SESSION? 
        // Or if we want full flow, we can't easily jump back to session select without sending new message.

        // Let's do: Type Select (Unknown Session) -> Modal.

        await showTypeSelection(i, config, 'UNKNOWN_SESSION', 'ADD'); // Type select will update the message of the button

    } catch (e) {
        // Timeout, just remove button
        await msg.delete().catch(() => { });
    }
}
