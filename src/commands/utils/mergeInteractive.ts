
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ComponentType,
    MessageComponentInteraction,
} from 'discord.js';
import { CommandContext } from '../types';
import { smartMergeBios } from '../../bard/reconciliation';

export interface MergeableEntity {
    id: string | number;
    shortId: string;
    name: string;
    description?: string;
    metadata?: string; // Optional info like "Role: Innkeeper"
}

export interface MergeConfig {
    entityType: string; // e.g., "NPC", "Luogo", "Fazione"
    emoji: string;
    campaignId: number;

    // Search/List helper
    listEntities: (campaignId: number) => MergeableEntity[];
    resolveEntity: (campaignId: number, query: string) => MergeableEntity | null;

    // Execution
    executeMerge: (campaignId: number, source: MergeableEntity, target: MergeableEntity, mergedDesc: string | null) => Promise<boolean>;
}

/**
 * Starts the generic interactive merge flow.
 */
export async function startInteractiveMerge(ctx: CommandContext, config: MergeConfig, initialArgs?: string) {
    let source: MergeableEntity | null = null;
    let target: MergeableEntity | null = null;

    // 1. Handle initial arguments (e.g. "$npc merge Source | Target" or "$npc merge #abcde | #fghij")
    if (initialArgs && initialArgs.includes('|')) {
        const parts = initialArgs.split('|').map(s => s.trim());
        if (parts.length >= 2) {
            source = config.resolveEntity(config.campaignId, parts[0]);
            target = config.resolveEntity(config.campaignId, parts[1]);
        }
    } else if (initialArgs) {
        // Just one arg provided, assume it's the source
        source = config.resolveEntity(config.campaignId, initialArgs);
    }

    if (source && target) {
        if (source.id === target.id) {
            await ctx.message.reply(`❌ Non puoi unire un'entità con se stessa.`);
            return;
        }
        return await showConfirmationStep(ctx, config, source, target);
    }

    // Start interactive flow
    if (!source) {
        return await showSelectionStep(ctx, config, 'SOURCE');
    } else {
        return await showSelectionStep(ctx, config, 'TARGET', source);
    }
}

/**
 * Shows the selection step (Source or Target)
 */
async function showSelectionStep(ctx: CommandContext, config: MergeConfig, step: 'SOURCE' | 'TARGET', alreadySelected?: MergeableEntity) {
    const entities = config.listEntities(config.campaignId);

    // Filter out already selected entity if pick target
    const available = step === 'TARGET' && alreadySelected
        ? entities.filter(e => e.id !== alreadySelected.id)
        : entities;

    if (available.length === 0) {
        await ctx.message.reply(`❌ Non ci sono abbastanza ${config.entityType.toLowerCase()} per eseguire un'unione.`);
        return;
    }

    const title = step === 'SOURCE'
        ? `🔴 Selezione ${config.entityType} da ELIMINARE`
        : `🟢 Selezione ${config.entityType} da MANTENERE`;

    const description = step === 'SOURCE'
        ? `L'entità selezionata sparirà e i suoi dati verranno trasferiti in un'altra.`
        : `L'entità selezionata assorbirà i dati di **${alreadySelected?.name}**.`;

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(step === 'SOURCE' ? '#E74C3C' : '#2ECC71')
        .setDescription(description + "\n\nSeleziona dalla lista qui sotto:");

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`merge_select_${step.toLowerCase()}`)
        .setPlaceholder(`🔍 Seleziona ${config.entityType}...`)
        .addOptions(
            available.slice(0, 25).map(e =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(e.name)
                    .setDescription(`ID: #${e.shortId}${e.metadata ? ` | ${e.metadata}` : ''}`)
                    .setValue(String(e.id))
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const reply = await ctx.message.reply({ embeds: [embed], components: [row] });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000 * 5,
    });

    collector.on('collect', async (interaction) => {
        if (interaction.user.id !== ctx.message.author.id) {
            await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
            return;
        }

        const selectedId = interaction.values[0];
        const selected = entities.find(e => String(e.id) === selectedId) || null;

        if (!selected) {
            await interaction.reply({ content: "Errore nella selezione.", ephemeral: true });
            return;
        }

        await interaction.deferUpdate();
        await reply.delete().catch(() => { });
        collector.stop();

        if (step === 'SOURCE') {
            await showSelectionStep(ctx, config, 'TARGET', selected);
        } else {
            await showConfirmationStep(ctx, config, alreadySelected!, selected);
        }
    });
}

/**
 * Shows the final confirmation step with side-by-side comparison
 */
async function showConfirmationStep(ctx: CommandContext, config: MergeConfig, source: MergeableEntity, target: MergeableEntity) {
    const embed = new EmbedBuilder()
        .setTitle(`🔀 Conferma Unione ${config.entityType}`)
        .setColor('#F1C40F')
        .setDescription(`Stai per unire due ${config.entityType.toLowerCase()}.`)
        .addFields(
            {
                name: '🔴 DA ELIMINARE (Sorgente)',
                value: `**${source.name}**\n\`#${source.shortId}\`\n${source.metadata || ''}`,
                inline: true
            },
            {
                name: '➡️',
                value: '\u200b',
                inline: true
            },
            {
                name: '🟢 DA MANTENERE (Destinazione)',
                value: `**${target.name}**\n\`#${target.shortId}\`\n${target.metadata || ''}`,
                inline: true
            }
        )
        .setFooter({ text: 'Tutta la cronologia e i riferimenti verranno spostati nella destinazione.' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('confirm_merge')
            .setLabel('Conferma Unione')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('smart_merge')
            .setLabel('Smart Merge AI (Bio)')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🧠'),
        new ButtonBuilder()
            .setCustomId('cancel_merge')
            .setLabel('Annulla')
            .setStyle(ButtonStyle.Secondary)
    );

    const reply = await ctx.message.reply({
        content: `⚠️ **Azione irreversibile!** Assicurati di aver selezionato correttamente chi eliminare e chi mantenere.`,
        embeds: [embed],
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000 * 5,
    });

    collector.on('collect', async (interaction) => {
        if (interaction.user.id !== ctx.message.author.id) {
            await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
            return;
        }

        if (interaction.customId === 'cancel_merge') {
            await interaction.update({ content: '❌ Unione annullata.', embeds: [], components: [] });
            collector.stop();
            return;
        }

        let mergedDesc: string | null = null;
        let isSmart = false;

        if (interaction.customId === 'smart_merge') {
            isSmart = true;
            await interaction.update({ content: '🧠 **Smart Merge in corso...** Analisi delle biografie via AI...', embeds: [embed], components: [] });

            try {
                mergedDesc = await smartMergeBios(
                    target.name,
                    target.description || "",
                    source.description || ""
                );
            } catch (e) {
                console.error("Smart merge failed:", e);
                await ctx.message.reply("⚠️ Errore durante lo smart merge AI. Procederò con l'unione standard.");
            }
        } else {
            await interaction.update({ content: '⚙️ Unione in corso...', embeds: [embed], components: [] });
        }

        const success = await config.executeMerge(config.campaignId, source, target, mergedDesc);

        if (success) {
            const finalEmbed = new EmbedBuilder()
                .setTitle(`✅ Unione Completata`)
                .setColor('#2ECC71')
                .setDescription(`L'entità **${source.name}** è stata unita a **${target.name}**.`);

            if (isSmart && mergedDesc) {
                finalEmbed.addFields({ name: '📜 Nuova Bio (Anteprima)', value: mergedDesc.length > 500 ? mergedDesc.substring(0, 500) + '...' : mergedDesc });
            }

            await interaction.editReply({ content: '', embeds: [finalEmbed], components: [] });
        } else {
            await interaction.editReply({ content: '❌ Errore durante l\'unione nel database.', embeds: [], components: [] });
        }

        collector.stop();
    });
}
