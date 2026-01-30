/**
 * Generic Entity Events Viewer
 * Reusable paginated events listing for all entity types
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';
import { CommandContext } from '../types';
import { db } from '../../db';

// Event type icons mapping
const EVENT_TYPE_ICONS: Record<string, string> = {
    // NPC events
    'ALLIANCE': '🤝',
    'BETRAYAL': '🗡️',
    'DEATH': '💀',
    'REVELATION': '💡',
    'STATUS_CHANGE': '🔄',
    // Character events
    'GROWTH': '📈',
    'TRAUMA': '💔',
    'ACHIEVEMENT': '🏆',
    'GOAL_CHANGE': '🎯',
    'BACKGROUND': '📜',
    'RELATIONSHIP': '💕',
    // Inventory events
    'LOOT': '💰',
    'USE': '🔧',
    'TRADE': '🔄',
    'LOST': '❌',
    // Quest events
    'PROGRESS': '🎯',
    'COMPLETE': '✅',
    'FAIL': '❌',
    'OPEN': '📋',
    'CLOSED': '🔒',
    // Bestiary events
    'ENCOUNTER': '⚔️',
    'KILL': '💀',
    // Location events
    'VISIT': '🚶',
    'DISCOVERY': '🔍',
    // Faction events
    'REPUTATION_CHANGE': '📊',
    'MEMBER_JOIN': '➕',
    'MEMBER_LEAVE': '➖',
    // Generic
    'UPDATE': '📝',
    'MANUAL_UPDATE': '✏️',
    'EVENT': '📋',
    'RECONCILED': '🔗',
    'default': '📋'
};

export interface EntityEventsConfig {
    /** SQL table name (e.g., 'npc_history', 'character_history') */
    tableName: string;
    /** Column name for entity key (e.g., 'npc_name', 'character_name') */
    entityKeyColumn: string;
    /** Value to match in entityKeyColumn */
    entityKeyValue: string;
    /** Campaign ID */
    campaignId: number;
    /** Display name for embed title */
    entityDisplayName: string;
    /** Emoji for entity type */
    entityEmoji: string;
    /** Optional: secondary key column (for atlas: micro_location) */
    secondaryKeyColumn?: string;
    /** Optional: secondary key value */
    secondaryKeyValue?: string;
}

interface HistoryEvent {
    id: number;
    description: string;
    event_type: string;
    session_id: string | null;
    timestamp: number | null;
    is_manual: number;
}

/**
 * Shows paginated events for any entity type
 */
export async function showEntityEvents(
    ctx: CommandContext,
    config: EntityEventsConfig,
    initialPage: number = 1
): Promise<void> {
    const ITEMS_PER_PAGE = 8;
    let currentPage = Math.max(0, initialPage - 1);

    // Build WHERE clause
    let whereClause = `campaign_id = ? AND LOWER(${config.entityKeyColumn}) = LOWER(?)`;
    let whereParams: any[] = [config.campaignId, config.entityKeyValue];

    if (config.secondaryKeyColumn && config.secondaryKeyValue) {
        whereClause += ` AND LOWER(${config.secondaryKeyColumn}) = LOWER(?)`;
        whereParams.push(config.secondaryKeyValue);
    }

    // Count total events
    const countQuery = `SELECT COUNT(*) as total FROM ${config.tableName} WHERE ${whereClause}`;
    const countResult = db.prepare(countQuery).get(...whereParams) as { total: number };
    const total = countResult.total;

    if (total === 0) {
        await ctx.message.reply(`📋 Nessun evento registrato per **${config.entityDisplayName}**.`);
        return;
    }

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    const generateEmbed = (page: number) => {
        const offset = page * ITEMS_PER_PAGE;
        const query = `
            SELECT id, description, event_type, session_id, timestamp, is_manual 
            FROM ${config.tableName} 
            WHERE ${whereClause}
            ORDER BY COALESCE(timestamp, 0) DESC, id DESC
            LIMIT ? OFFSET ?
        `;
        const events = db.prepare(query).all(...whereParams, ITEMS_PER_PAGE, offset) as HistoryEvent[];

        if (events.length === 0 && page > 0) {
            return {
                embed: new EmbedBuilder().setDescription("❌ Pagina inesistente."),
                totalPages
            };
        }

        const list = events.map(evt => {
            const icon = EVENT_TYPE_ICONS[evt.event_type] || EVENT_TYPE_ICONS['default'];
            const sessionTag = evt.session_id ? `\`${evt.session_id}\`` : '—';
            const date = evt.timestamp
                ? new Date(evt.timestamp).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' })
                : '—';
            const manualTag = evt.is_manual ? ' ✏️' : '';

            // Truncate description if too long
            // Truncate description if too long
            const desc = evt.description.length > 350
                ? evt.description.substring(0, 347) + '...'
                : evt.description;

            return `${icon} ${desc}${manualTag}\n> 📅 ${date} • 🎬 ${sessionTag}`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle(`${config.entityEmoji} Cronologia: ${config.entityDisplayName}`)
            .setColor("#9B59B6")
            .setDescription(list)
            .setFooter({ text: `Pagina ${page + 1} di ${totalPages} • Totale: ${total} eventi` });

        return { embed, totalPages };
    };

    const generateButtons = (page: number) => {
        const row = new ActionRowBuilder<ButtonBuilder>();
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('events_prev_page')
                .setLabel('⬅️ Precedente')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId('events_next_page')
                .setLabel('Successivo ➡️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === totalPages - 1)
        );
        return row;
    };

    const initialData = generateEmbed(currentPage);

    const components: any[] = [];
    if (totalPages > 1) {
        components.push(generateButtons(currentPage));
    }

    const reply = await ctx.message.reply({
        embeds: [initialData.embed],
        components
    });

    if (totalPages > 1) {
        const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000 * 5 // 5 minutes
        });

        collector.on('collect', async (interaction: MessageComponentInteraction) => {
            if (interaction.user.id !== ctx.message.author.id) {
                await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
                return;
            }

            if (interaction.customId === 'events_prev_page') {
                currentPage = Math.max(0, currentPage - 1);
            } else if (interaction.customId === 'events_next_page') {
                currentPage = Math.min(totalPages - 1, currentPage + 1);
            }

            const newData = generateEmbed(currentPage);
            await interaction.update({
                embeds: [newData.embed],
                components: totalPages > 1 ? [generateButtons(currentPage)] : []
            });
        });

        collector.on('end', () => {
            reply.edit({ components: [] }).catch(() => { });
        });
    }
}
