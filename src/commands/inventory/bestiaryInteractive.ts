import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ComponentType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} from 'discord.js';
import { CommandContext } from '../types';
import {
    bestiaryRepository,
    db
} from '../../db';
import { BestiaryEntry } from '../../db/types';
import { guildSessions } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';

// Helper for Bio Regen - usato SOLO per note narrative
async function regenerateMonsterBio(campaignId: number, monsterName: string) {
    const history = bestiaryRepository.getBestiaryHistory(campaignId, monsterName);
    const monster = bestiaryRepository.getMonsterByName(campaignId, monsterName);
    const currentDesc = monster?.description || "";
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('MONSTER', { campaignId, name: monsterName, currentDesc }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markBestiaryDirtyForSync(campaignId: number, name: string) {
    bestiaryRepository.markBestiaryDirty(campaignId, name);
}

export async function startInteractiveBestiaryUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let monster = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, query);
        if (!monster) monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, query);

        if (monster) {
            await showBestiaryFieldSelection(ctx.message as any, monster, ctx, true);
            return;
        }
    }
    await showBestiarySelection(ctx, null, 0, null, 'UPDATE');
}

export async function startInteractiveBestiaryDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let monster = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, query);
        if (!monster) monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, query);

        if (monster) {
            await showBestiaryDeleteConfirmation(ctx.message as any, monster, ctx, true);
            return;
        }
    }
    await showBestiarySelection(ctx, null, 0, null, 'DELETE');
}

async function showBestiarySelection(
    ctx: CommandContext,
    searchQuery: string | null,
    page: number,
    interactionToUpdate: any | null,
    mode: 'UPDATE' | 'DELETE'
) {
    const ITEMS_PER_PAGE = 20;
    const offset = page * ITEMS_PER_PAGE;
    let monsters: BestiaryEntry[] = [];

    // For listing, we use listMonsters which groups by name
    const all = bestiaryRepository.listAllMonsters(ctx.activeCampaign!.id);
    let filtered = all;

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = all.filter(m => m.name.toLowerCase().includes(q) || (m.description && m.description.toLowerCase().includes(q)));
    }

    const total = filtered.length;
    monsters = filtered.slice(offset, offset + ITEMS_PER_PAGE);
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    const options = monsters.map(m => {
        const statusIcon = m.status === 'ALIVE' ? '⚔️' : m.status === 'DEFEATED' ? '💀' : '🏃';
        const countStr = m.count ? `(x${m.count})` : '';
        return new StringSelectMenuOptionBuilder()
            .setLabel(m.name.substring(0, 100))
            .setDescription(`ID: #${m.short_id} | ${statusIcon} ${m.status} ${countStr}`)
            .setValue(m.name)
            .setEmoji(statusIcon);
    });

    if (page === 0 && options.length < 25) {
        options.unshift(
            new StringSelectMenuOptionBuilder()
                .setLabel("🔍 Cerca...")
                .setValue("SEARCH_ACTION")
                .setEmoji('🔍')
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('bestiary_select_entity')
        .setPlaceholder(`Seleziona un mostro...`)
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('page_prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('page_next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const content = `**🛠️ ${mode === 'DELETE' ? 'Eliminazione' : 'Aggiornamento'} Bestiario**\nPagina: ${page + 1}/${totalPages || 1}`;

    let response;
    if (interactionToUpdate) {
        await interactionToUpdate.update({ content, components: rows });
        response = interactionToUpdate.message;
    } else {
        response = await ctx.message.reply({ content, components: rows });
    }

    const collector = response.createMessageComponentCollector({
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction: any) => {
        if (interaction.isStringSelectMenu()) {
            const val = interaction.values[0];
            if (val === 'SEARCH_ACTION') {
                collector.stop();
                const modal = new ModalBuilder().setCustomId('modal_best_search').setTitle("🔍 Cerca nel Bestiario");
                const input = new TextInputBuilder().setCustomId('search_query').setLabel("Nome o descrizione").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
                await interaction.showModal(modal);

                try {
                    const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_best_search' && i.user.id === interaction.user.id });
                    await showBestiarySelection(ctx, submission.fields.getTextInputValue('search_query'), 0, submission, mode);
                } catch (e) { }
            } else {
                collector.stop();
                const monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, val);
                if (!monster) return;
                if (mode === 'DELETE') await showBestiaryDeleteConfirmation(interaction, monster, ctx);
                else await showBestiaryFieldSelection(interaction, monster, ctx);
            }
        } else if (interaction.isButton()) {
            collector.stop();
            if (interaction.customId === 'page_prev') {
                await showBestiarySelection(ctx, searchQuery, page - 1, interaction, mode);
            } else if (interaction.customId === 'page_next') {
                await showBestiarySelection(ctx, searchQuery, page + 1, interaction, mode);
            }
        }
    });
}

async function showBestiaryDeleteConfirmation(interaction: any, monster: BestiaryEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('btn_confirm_delete').setLabel('Conferma Eliminazione').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('btn_cancel_delete').setLabel('Annulla').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const content = `⚠️ **Sei sicuro di voler eliminare definitivamente: ${monster.name}?**\nQuesto rimuoverà anche tutta la sua storia e varianti.`;
    const options = { content, components: [row] };

    const message = isNewMessage ? await interaction.reply(options) : await interaction.update(options);
    const target = isNewMessage ? message : interaction.message;

    const collector = target.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        if (i.customId === 'btn_confirm_delete') {
            bestiaryRepository.deleteMonster(ctx.activeCampaign!.id, monster.name);
            await i.update({ content: `✅ Mostro **${monster.name}** eliminato definitivamente.`, components: [] });
        } else {
            await i.update({ content: "❌ Eliminazione annullata.", components: [] });
        }
    });
}

async function showBestiaryFieldSelection(interaction: any, monster: BestiaryEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('bestiary_select_field')
        .setPlaceholder(`Modifica: ${monster.name}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Nome').setValue('name').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Stato').setValue('status').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel('Numero/Count').setValue('count').setEmoji('🔢'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Abilità').setValue('abilities').setEmoji('⚔️'),
            new StringSelectMenuOptionBuilder().setLabel('Debolezze').setValue('weaknesses').setEmoji('🎯'),
            new StringSelectMenuOptionBuilder().setLabel('Resistenze').setValue('resistances').setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder().setLabel('Note').setValue('notes').setEmoji('📝'),
            new StringSelectMenuOptionBuilder().setLabel('Nota Narrativa').setValue('note').setEmoji('📓')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = `**🛠️ Modifica Bestiario: ${monster.name}**\nCosa vuoi aggiornare?`;
    const options = { content, components: [row] };

    const message = isNewMessage ? await interaction.reply(options) : await interaction.update(options);
    const target = isNewMessage ? message : interaction.message;

    const collector = target.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const field = i.values[0];
        if (field === 'status') await showBestiaryStatusUpdate(i, monster, ctx);
        else if (['abilities', 'weaknesses', 'resistances'].includes(field)) await showBestiaryArrayModal(i, monster, field, ctx);
        else await showBestiaryTextModal(i, monster, field, ctx);
    });
}

async function showBestiaryStatusUpdate(interaction: any, monster: BestiaryEntry, ctx: CommandContext) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('bestiary_update_status')
        .setPlaceholder('Nuovo stato...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('VIVO (Alive)').setValue('ALIVE').setEmoji('⚔️').setDefault(monster.status === 'ALIVE'),
            new StringSelectMenuOptionBuilder().setLabel('SCONFITTO (Defeated)').setValue('DEFEATED').setEmoji('💀').setDefault(monster.status === 'DEFEATED'),
            new StringSelectMenuOptionBuilder().setLabel('FUGGITO (Fled)').setValue('FLED').setEmoji('🏃').setDefault(monster.status === 'FLED')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ content: `**Aggiorna Stato di: ${monster.name}**`, components: [row] });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newStatus = i.values[0];

        // Aggiorna stato e marca dirty per sync in background
        bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { status: newStatus }, true);
        markBestiaryDirtyForSync(ctx.activeCampaign!.id, monster.name);

        // NON aggiungiamo eventi automatici per cambio stato - sono rumore narrativo

        await i.update({ content: `✅ Stato di **${monster.name}** aggiornato a **${newStatus}**!`, components: [] });
    });
}

async function showBestiaryArrayModal(interaction: any, monster: BestiaryEntry, field: string, ctx: CommandContext) {
    const modalId = `modal_barray_${Date.now()}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Modifica ${field}`);

    let currentVal = "";
    try {
        const arr = (monster as any)[field] ? JSON.parse((monster as any)[field]) : [];
        currentVal = arr.join(', ');
    } catch (e) { }

    const input = new TextInputBuilder()
        .setCustomId('values')
        .setLabel(`Valori (separati da virgola)`)
        .setStyle(TextInputStyle.Paragraph)
        .setValue(currentVal)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id });
        const newValue = submission.fields.getTextInputValue('values');
        const items = newValue.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);

        bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { [field]: items }, true);
        await submission.reply(`✅ **${monster.name}** aggiornato (${field}).`);
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showBestiaryTextModal(interaction: any, monster: BestiaryEntry, field: string, ctx: CommandContext) {
    const modalId = `modal_btext_${Date.now()}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Modifica ${field}`);
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'note' ? "Nota Narrativa" : `Nuovo ${field}`)
        .setStyle(field === 'description' || field === 'notes' || field === 'note' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(field === 'note' ? "" : (monster as any)[field] || "")
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id });
        const newValue = submission.fields.getTextInputValue('value');

        if (field === 'note') {
            await submission.deferReply();
            const session = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            bestiaryRepository.addBestiaryEvent(ctx.activeCampaign!.id, monster.name, session, newValue, "MANUAL_UPDATE", true);
            await regenerateMonsterBio(ctx.activeCampaign!.id, monster.name);
            await submission.editReply(`📝 Nota aggiunta a **${monster.name}**.`);
        } else {
            bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { [field]: newValue }, true);
            if (field === 'name') {
                // Update history records as well
                db.prepare('UPDATE bestiary_history SET monster_name = ? WHERE campaign_id = ? AND monster_name = ?')
                    .run(newValue, ctx.activeCampaign!.id, monster.name);
            }
            await submission.reply(`✅ **${monster.name}** aggiornato (${field}).`);
        }
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}
