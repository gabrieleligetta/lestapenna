
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
import { db, eventRepository, sessionRepository } from '../../db';
import { EntityEventsConfig, showEntityEvents } from './eventsViewer';

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
        .setPlaceholder('📅 Seleziona la sessione dell\'evento...')
        .addOptions([
            new StringSelectMenuOptionBuilder()
                .setLabel('Nessuna / Fuori Sessione')
                .setDescription('Aggiungi evento senza legarlo a una sessione specifica')
                .setValue('UNKNOWN_SESSION')
                .setEmoji('🚫'),
            ...sessions.map((s: any) => {
                const date = new Date(s.start_time).toLocaleDateString();
                return new StringSelectMenuOptionBuilder()
                    .setLabel(`Sessione ${s.session_number}: ${s.title || 'Senza Titolo'}`)
                    .setDescription(`📅 ${date} - ID: ${s.session_id}`)
                    .setValue(s.session_id)
                    .setEmoji('🎬');
            })
        ]);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const reply = await ctx.message.reply({
        content: `📅 **A quale sessione appartiene l'evento?**`,
        components: [row]
    });

    // Create collector
    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000
    });

    collector.on('collect', async (i: any) => {
        if (i.user.id !== ctx.message.author.id) {
            await i.reply({ content: "Non autorizzato.", ephemeral: true });
            return;
        }

        const sessionId = i.values[0];

        // Show Modal
        // Note: showModal MUST be called directly on an interaction that hasn't been replied/deferred to yet.
        // We catch it here.
        await showAddModalOnInteraction(i, config, sessionId, preFilledContent);

        // Clean up the selector message
        await reply.delete().catch(() => { });

    });

    collector.on('end', (collected: any, reason: any) => {
        if (reason === 'time' && collected.size === 0) {
            reply.edit({ content: "⏱️ Tempo scaduto per la selezione.", components: [] }).catch(() => { });
        }
    });
}

// Helper to show modal on an existing interaction (Select Menu click)
async function showAddModalOnInteraction(interaction: any, config: EntityEventsConfig, sessionId: string, preFilledContent?: string) {
    const modalId = `event_add_${sessionId}_${Date.now()}`;
    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`Agg. Evento: ${config.entityDisplayName} (S: ${sessionId === 'UNKNOWN_SESSION' ? 'No' : sessionId})`);

    const descInput = new TextInputBuilder()
        .setCustomId('event_description')
        .setLabel("Descrizione Evento")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Cosa è successo?")
        .setRequired(true);

    if (preFilledContent) descInput.setValue(preFilledContent.slice(0, 4000));

    const typeInput = new TextInputBuilder()
        .setCustomId('event_type')
        .setLabel("Tipo Evento (opzionale)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Es. ENCOUNTER, NOTE, DISCOVERY")
        .setRequired(false);

    // No session input needed in modal anymore, it's in the ID

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput)
    );

    await interaction.showModal(modal);
    await handleModalSubmit(interaction, config, modalId, 'ADD', undefined, sessionId);
}

// Fallback helper for text-only invocation if needed (but currently we force flow via select mainly)
async function showAddModal(ctx: CommandContext, config: EntityEventsConfig, sessionId: string, preFilledContent?: string) {
    // This needs a button trigger if not interaction based, similar to previous implementation
    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('open_event_add_modal_fb')
            .setLabel('📝 Compila Dettagli')
            .setStyle(ButtonStyle.Success)
    );

    const reply = await ctx.message.reply({
        content: `Per aggiungere un evento a **${config.entityDisplayName}** (Sessione: ${sessionId}), clicca qui sotto:`,
        components: [btnRow]
    });

    try {
        const interaction = await reply.awaitMessageComponent({
            filter: i => i.user.id === ctx.message.author.id && i.customId === 'open_event_add_modal_fb',
            time: 60000
        });
        await showAddModalOnInteraction(interaction, config, sessionId, preFilledContent);
        await reply.delete().catch(() => { });
    } catch (e) {
        await reply.edit({ content: "⏱️ Tempo scaduto.", components: [] });
    }
}


async function handleModalSubmit(interaction: MessageComponentInteraction, config: EntityEventsConfig, modalId: string, mode: 'ADD' | 'UPDATE', eventId?: number, sessionIdArg?: string) {
    const filter = (i: ModalSubmitInteraction) => i.customId === modalId && i.user.id === interaction.user.id;
    try {
        const submission = await interaction.awaitModalSubmit({ filter, time: 300000 });

        const description = submission.fields.getTextInputValue('event_description');
        const type = submission.fields.getTextInputValue('event_type') || (mode === 'ADD' ? 'MANUAL_NOTE' : undefined);

        // For ADD, sessionId comes from arg. For UPDATE, it might come from modal if we allowed editing it (re-add field if useful?)
        // In previous implementation UPDATE had session input. Let's keep it for UPDATE.

        let session = sessionIdArg;
        if (mode === 'UPDATE') {
            try { session = submission.fields.getTextInputValue('event_session'); } catch (e) { }
        }

        if (session === 'UNKNOWN_SESSION') session = undefined;

        if (mode === 'ADD') {
            eventRepository.addEvent(
                config.tableName,
                config.entityKeyColumn,
                config.entityKeyValue,
                config.campaignId,
                description,
                type!,
                session,
                undefined, // timestamp
                config.secondaryKeyColumn,
                config.secondaryKeyValue
            );
            await submission.reply({ content: `✅ Evento aggiunto a **${config.entityDisplayName}**!`, ephemeral: false });
        } else if (mode === 'UPDATE' && eventId) {
            eventRepository.updateEvent(config.tableName, eventId, description, session, type);
            await submission.reply({ content: `✅ Evento aggiornato!`, ephemeral: false });
        }

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
            await ctx.message.reply(`❌ Evento #${eventId} non trovato.`);
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
            await ctx.message.reply(`❌ Evento #${eventId} non trovato.`);
            return;
        }

        await confirmAndDelete(ctx, config, event);
        return;
    }

    // 2. Else, Interactive Selection
    await startEventSelectionFlow(ctx, config, 'DELETE');
}

// --- Helpers ---

async function showEditModal(ctx: CommandContext, config: EntityEventsConfig, event: any) {
    const modalId = `event_edit_${event.id}_${Date.now()}`;
    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`Modifica Evento #${event.id}`);

    const descInput = new TextInputBuilder()
        .setCustomId('event_description')
        .setLabel("Descrizione")
        .setStyle(TextInputStyle.Paragraph)
        .setValue(event.description)
        .setRequired(true);

    const typeInput = new TextInputBuilder()
        .setCustomId('event_type')
        .setLabel("Tipo")
        .setStyle(TextInputStyle.Short)
        .setValue(event.event_type || '')
        .setRequired(false);

    const sessionInput = new TextInputBuilder()
        .setCustomId('event_session')
        .setLabel("Sessione")
        .setStyle(TextInputStyle.Short)
        .setValue(event.session_id || '')
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(sessionInput)
    );

    // Trigger via button since we are in text command context
    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`trigger_edit_${event.id}`)
            .setLabel(`📝 Modifica Evento #${event.id}`)
            .setStyle(ButtonStyle.Primary)
    );

    const reply = await ctx.message.reply({
        content: `Clicca per modificare l'evento:`,
        components: [btnRow]
    });

    try {
        const interaction = await reply.awaitMessageComponent({
            filter: i => i.user.id === ctx.message.author.id && i.customId === `trigger_edit_${event.id}`,
            time: 60000
        });
        await interaction.showModal(modal as any);
        await handleModalSubmit(interaction, config, modalId, 'UPDATE', event.id);
        await reply.delete().catch(() => { });
    } catch (e) {
        await reply.edit({ content: "⏱️ Tempo scaduto.", components: [] });
    }
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
        await ctx.message.reply(`❌ Nessun evento trovato per **${config.entityDisplayName}**.`);
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(`select_event_${mode}`)
        .setPlaceholder(`Seleziona evento da ${mode === 'UPDATE' ? 'modificare' : 'eliminare'}...`)
        .addOptions(events.map(e => {
            const desc = e.description.substring(0, 50);
            return new StringSelectMenuOptionBuilder()
                .setLabel(`#${e.id} - ${e.event_type}`)
                .setDescription(`${e.session_id ? `[S${e.session_id}] ` : ''}${desc}...`)
                .setValue(e.id.toString())
        }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const reply = await ctx.message.reply({
        content: `Seleziona l'evento da **${mode === 'UPDATE' ? 'MODIFICARE' : 'ELIMINARE'}**:`,
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000
    });

    collector.on('collect', async (i) => {
        if (i.user.id !== ctx.message.author.id) {
            await i.reply({ content: "Non autorizzato.", ephemeral: true });
            return;
        }

        const eventId = parseInt(i.values[0]);
        const event = events.find(e => e.id === eventId);

        if (!event) {
            await i.reply({ content: "Errore: evento non trovato.", ephemeral: true });
            return;
        }

        if (mode === 'UPDATE') {
            await i.deferUpdate(); // Acknowledge selection
            await reply.delete().catch(() => { }); // Cleanup selection menu
            await showEditModal(ctx, config, event); // Launch modal flow
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
        new ButtonBuilder().setCustomId('confirm_del').setLabel('🗑️ Conferma Eliminazione').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel_del').setLabel('Annulla').setStyle(ButtonStyle.Secondary)
    );

    const reply = await ctx.message.reply({
        content: `⚠️ Sei sicuro di voler eliminare l'evento #${event.id}?\n> ${event.description}`,
        components: [row]
    });

    try {
        const i = await reply.awaitMessageComponent({
            filter: i => i.user.id === ctx.message.author.id,
            time: 30000
        });

        if (i.customId === 'confirm_del') {
            eventRepository.deleteEvent(config.tableName, event.id);
            await i.update({ content: `✅ Evento eliminato.`, components: [] });
        } else {
            await i.update({ content: "Operazione annullata.", components: [] });
        }
    } catch {
        await reply.edit({ content: "⏱️ Tempo scaduto.", components: [] });
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
            .setLabel('➕ Aggiungi Evento')
            .setStyle(ButtonStyle.Success)
    );

    const msg = await (ctx.message.channel as any).send({ components: [row] });

    try {
        const i = await msg.awaitMessageComponent({
            filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'trigger_add_event',
            time: 60000
        });

        await msg.delete().catch(() => { });
        // We can't use `showModal` on a message component from a *different* interaction easily if we want to chain it 
        // properly without "This interaction has already been acknowledged".
        // But here we just caught the button click. We MUST show modal on THIS interaction.

        const modalId = `event_add_quick_${Date.now()}`;
        const modal = new ModalBuilder()
            .setCustomId(modalId)
            .setTitle(`Aggiungi Evento: ${config.entityDisplayName}`);

        const descInput = new TextInputBuilder()
            .setCustomId('event_description')
            .setLabel("Descrizione")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const typeInput = new TextInputBuilder()
            .setCustomId('event_type')
            .setLabel("Tipo")
            .setStyle(TextInputStyle.Short)
            .setValue('MANUAL')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput)
        );

        await i.showModal(modal as any);
        await handleModalSubmit(i as any, config, modalId, 'ADD');

    } catch (e) {
        // Timeout, just remove button
        await msg.delete().catch(() => { });
    }
}
