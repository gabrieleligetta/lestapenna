import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageComponentInteraction,
    StringSelectMenuInteraction,
    ButtonInteraction,
    Message,
    EmbedBuilder
} from 'discord.js';
import { CommandContext } from '../types';
import {
    factionRepository,
    locationRepository,
    db
} from '../../db';
import { AffiliationRole } from '../../db/types';

const ROLE_ICONS: Record<AffiliationRole, string> = {
    'LEADER': '👑',
    'MEMBER': '👤',
    'ALLY': '🤝',
    'ENEMY': '⚔️',
    'CONTROLLED': '🏛️',
    'HQ': '🏰',
    'PRESENCE': '📍',
    'HOSTILE': '💢',
    'PRISONER': '⛓️'
};

const ROLE_LABELS: Record<AffiliationRole, string> = {
    'LEADER': 'Leader',
    'MEMBER': 'Membro',
    'ALLY': 'Alleato',
    'ENEMY': 'Nemico',
    'CONTROLLED': 'Controllo',
    'HQ': 'Sede (HQ)',
    'PRESENCE': 'Presenza',
    'HOSTILE': 'Ostile',
    'PRISONER': 'Prigioniero'
};

export function getRoleLabel(role: string): string {
    return ROLE_LABELS[role as AffiliationRole] || role;
}

/**
 * Main Interactive Menu for $affiliate
 */
export async function startInteractiveAffiliate(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_aff_add')
                .setLabel('➕ Nuova Affiliazione')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('btn_aff_remove')
                .setLabel('➖ Rimuovi Affiliazione')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('btn_aff_list')
                .setLabel('📋 Lista per Fazione')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('btn_aff_check')
                .setLabel('🔍 Check Entità')
                .setStyle(ButtonStyle.Secondary)
        );

    const reply = await ctx.message.reply({
        content: "🤝 **Gestione Affiliazioni Fazioni**\nCosa vuoi fare?",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i: MessageComponentInteraction) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction: ButtonInteraction) => {
        if (interaction.customId === 'btn_aff_add') {
            await startInteractiveAffiliateAdd(ctx, interaction);
            collector.stop('done');
        } else if (interaction.customId === 'btn_aff_remove') {
            await startInteractiveAffiliateRemove(ctx, interaction);
            collector.stop('done');
        } else if (interaction.customId === 'btn_aff_list') {
            await startInteractiveAffiliateList(ctx, interaction);
            collector.stop('done');
        } else if (interaction.customId === 'btn_aff_check') {
            await startInteractiveAffiliateOf(ctx, interaction);
            collector.stop('done');
        }
    });
}

/**
 * ADD FLOW: Select Type -> Select Entity -> Select Faction -> Select Role
 */
export async function startInteractiveAffiliateAdd(ctx: CommandContext, originInteraction?: MessageComponentInteraction) {
    // 1. SELECT TYPE
    const rowType = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('type_npc').setLabel('👤 NPC').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('type_location').setLabel('📍 Luogo').setStyle(ButtonStyle.Primary)
        );

    let activeMessage: Message;
    if (originInteraction) {
        if (originInteraction.replied || originInteraction.deferred) {
            activeMessage = await originInteraction.editReply({ content: "1️⃣ **Che tipo di entità vuoi affiliare?**", components: [rowType] }) as Message;
        } else {
            await originInteraction.update({ content: "1️⃣ **Che tipo di entità vuoi affiliare?**", components: [rowType] });
            activeMessage = originInteraction.message as Message;
        }
    } else {
        activeMessage = await ctx.message.reply({ content: "1️⃣ **Che tipo di entità vuoi affiliare?**", components: [rowType] });
    }

    const collector = activeMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (i: MessageComponentInteraction) => i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (typeInteract: ButtonInteraction) => {
        const type = typeInteract.customId === 'type_npc' ? 'npc' : 'location';

        // 2. SELECT ENTITY (Recursive step to handle selection)
        await selectEntityInteractive(ctx, typeInteract, type, async (entityInt, entityId, entityName) => {

            // 3. SELECT FACTION
            await selectFactionInteractive(ctx, entityInt, async (factionInt, factionId, factionName) => {

                // 4. SELECT ROLE
                await selectRoleInteractive(ctx, factionInt, type as any, async (role) => {

                    // EXECUTE
                    const success = factionRepository.addAffiliation(factionId, type as any, entityId, { role });

                    if (success) {
                        factionRepository.addFactionEvent(
                            ctx.activeCampaign!.id,
                            factionName,
                            null,
                            `${type.toUpperCase()} "${entityName}" affiliato come ${role}`,
                            'MEMBER_JOIN',
                            true
                        );
                        // Safe reply via interaction
                        if (factionInt.replied || factionInt.deferred) {
                            await factionInt.followUp(`✅ **${entityName}** ora è **${role}** di **${factionName}**!`);
                        } else {
                            // Note: selectRoleInteractive updates to "Salvataggio...", so we can edit/followUp
                            await factionInt.editReply({ content: `✅ **${entityName}** ora è **${role}** di **${factionName}**!`, components: [] });
                        }
                    } else {
                        if (factionInt.replied || factionInt.deferred) {
                            await factionInt.followUp(`❌ Errore durante l'affiliazione. Forse esiste già?`);
                        } else {
                            await factionInt.editReply({ content: `❌ Errore durante l'affiliazione. Forse esiste già?`, components: [] });
                        }
                    }
                });
            });
        });
    });
}

/**
 * REMOVE FLOW: Select Type -> Select Entity -> Select Affiliation to Remove
 */
export async function startInteractiveAffiliateRemove(ctx: CommandContext, originInteraction?: MessageComponentInteraction) {
    // 1. SELECT TYPE
    const rowType = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('type_npc').setLabel('👤 NPC').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('type_location').setLabel('📍 Luogo').setStyle(ButtonStyle.Primary)
        );

    let activeMessage: Message;
    if (originInteraction) {
        if (originInteraction.replied || originInteraction.deferred) {
            activeMessage = await originInteraction.editReply({ content: "1️⃣ **Di chi vuoi rimuovere l'affiliazione?**", components: [rowType] }) as Message;
        } else {
            await originInteraction.update({ content: "1️⃣ **Di chi vuoi rimuovere l'affiliazione?**", components: [rowType] });
            activeMessage = originInteraction.message as Message;
        }
    } else {
        activeMessage = await ctx.message.reply({ content: "1️⃣ **Di chi vuoi rimuovere l'affiliazione?**", components: [rowType] });
    }

    const collector = activeMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (i: MessageComponentInteraction) => i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (typeInteract: ButtonInteraction) => {
        const type = typeInteract.customId === 'type_npc' ? 'npc' : 'location';

        // 2. SELECT ENTITY
        await selectEntityInteractive(ctx, typeInteract, type, async (entityInt, entityId, entityName) => {

            // 3. SELECT AFFILIATION TO REMOVE
            const affiliations = factionRepository.getEntityFactions(type as any, entityId);

            if (affiliations.length === 0) {
                await entityInt.followUp({ content: `❌ **${entityName}** non ha alcuna affiliazione.`, ephemeral: true });
                return;
            }

            const options = affiliations.map(a =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(a.faction_name || "Sconosciuto")
                    .setDescription(`Ruolo: ${a.role}`)
                    .setValue(a.faction_id.toString())
                    .setEmoji(ROLE_ICONS[a.role as AffiliationRole] || '🔗')
            );

            const row = new ActionRowBuilder<StringSelectMenuBuilder>()
                .addComponents(new StringSelectMenuBuilder().setCustomId('sel_remove_aff').setPlaceholder('Scegli fazione da rimuovere...').addOptions(options));

            await entityInt.update({ content: `3️⃣ **Da quale fazione vuoi rimuovere ${entityName}?**`, components: [row] });

            const selCol = entityInt.message.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                filter: (i) => i.user.id === ctx.message.author.id,
                time: 60000,
                max: 1
            });

            selCol.on('collect', async (selInt: StringSelectMenuInteraction) => {
                const factionId = parseInt(selInt.values[0]);
                const factionName = affiliations.find(a => a.faction_id === factionId)?.faction_name || "Sconosciuto";

                const success = factionRepository.removeAffiliation(factionId, type as any, entityId);

                if (success) {
                    factionRepository.addFactionEvent(
                        ctx.activeCampaign!.id,
                        factionName,
                        null,
                        `${type.toUpperCase()} "${entityName}" ha lasciato la fazione`,
                        'MEMBER_LEAVE',
                        true
                    );
                    await selInt.update({ content: `✅ Rimossa affiliazione di **${entityName}** da **${factionName}**.`, components: [] });
                } else {
                    await selInt.update({ content: `❌ Errore durante la rimozione.`, components: [] });
                }
            });
        });
    });
}


// --- HELPERS ---

async function selectEntityInteractive(
    ctx: CommandContext,
    interaction: MessageComponentInteraction,
    type: 'npc' | 'location',
    onSelect: (interaction: StringSelectMenuInteraction, id: number, name: string) => Promise<void>
) {
    const campaignId = ctx.activeCampaign!.id;
    let options: StringSelectMenuOptionBuilder[] = [];

    if (type === 'npc') {
        const rows = db.prepare(`SELECT id, name, role FROM npc_dossier WHERE campaign_id = ? ORDER BY id DESC LIMIT 25`).all(campaignId) as any[];
        options = rows.map(r => new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(r.id.toString()).setDescription(r.role || 'NPC').setEmoji('👤'));
    } else {
        const rows = locationRepository.listAtlasEntries(campaignId, 25, 0);
        options = rows.map((r: any) => new StringSelectMenuOptionBuilder().setLabel(`${r.macro_location} | ${r.micro_location}`.substring(0, 100)).setValue(r.id.toString()).setEmoji('📍'));
    }

    if (options.length === 0) {
        if (interaction.isRepliable()) {
            await interaction.reply({ content: `❌ Nessun ${type} trovato. Crealo prima o usa il comando testuale.`, ephemeral: true });
        }
        return;
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(new StringSelectMenuBuilder().setCustomId('sel_entity').setPlaceholder(`Seleziona ${type}...`).addOptions(options));

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: `2️⃣ **Seleziona ${type}:**`, components: [row], embeds: [] });
    } else {
        await interaction.update({ content: `2️⃣ **Seleziona ${type}:**`, components: [row], embeds: [] });
    }

    // Get the message from the interaction (it was updated)
    const msg = interaction.message;

    const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i: MessageComponentInteraction) => i.customId === 'sel_entity' && i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (selInt: StringSelectMenuInteraction) => {
        const id = parseInt(selInt.values[0]);
        const label = options.find(o => o.data.value === id.toString())?.data.label || "Sconosciuto";
        // Pass the new interaction to the next step
        await onSelect(selInt, id, label);
    });
}

async function selectFactionInteractive(
    ctx: CommandContext,
    interaction: MessageComponentInteraction,
    onSelect: (interaction: StringSelectMenuInteraction, id: number, name: string) => Promise<void>
) {
    const factions = factionRepository.listFactions(ctx.activeCampaign!.id);

    if (factions.length === 0) {
        if (interaction.isRepliable()) {
            await interaction.followUp({ content: "❌ Nessuna fazione trovata.", ephemeral: true });
        }
        return;
    }

    const options = factions.map(f =>
        new StringSelectMenuOptionBuilder()
            .setLabel(f.name)
            .setValue(f.id.toString())
            .setDescription(f.type || 'Fazione')
            .setEmoji('🏴')
    );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(new StringSelectMenuBuilder().setCustomId('sel_faction').setPlaceholder('Seleziona Fazione...').addOptions(options));

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: "3️⃣ **A quale fazione appartiene?**", components: [row], embeds: [] });
    } else {
        await interaction.update({ content: "3️⃣ **A quale fazione appartiene?**", components: [row], embeds: [] });
    }

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i: MessageComponentInteraction) => i.customId === 'sel_faction' && i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (selInt: StringSelectMenuInteraction) => {
        const id = parseInt(selInt.values[0]);
        const name = factions.find(f => f.id === id)?.name || "Sconosciuto";
        await onSelect(selInt, id, name);
    });
}

/**
 * LIST FLOW: Select Faction -> Show Embed
 */
export async function startInteractiveAffiliateList(ctx: CommandContext, originInteraction?: MessageComponentInteraction) {
    await selectFactionInteractive(ctx, originInteraction!, async (factionInt, factionId, factionName) => {
        const members = factionRepository.getFactionMembers(factionId);

        if (members.length === 0) {
            await factionInt.update({ content: `📋 La fazione **${factionName}** non ha membri affiliati.`, components: [] });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(`📋 Membri di "${factionName}"`)
            .setColor("#E67E22");

        const npcs = members.filter(m => m.entity_type === 'npc');
        const locations = members.filter(m => m.entity_type === 'location');

        if (npcs.length > 0) {
            const lines = npcs.map(m => {
                const icon = ROLE_ICONS[m.role as AffiliationRole] || '👤';
                const label = ROLE_LABELS[m.role as AffiliationRole] || m.role;
                // We don't have the entity name here, butgetRepository.getFactionMembers usually returns enough data if updated.
                // Looking at repository, let's assume we need to join or assume entity name is in the result.
                return `${icon} **${m.entity_name || `ID:${m.entity_id}`}** (${label})`;
            }).join('\n');
            embed.addFields({ name: "👤 NPC", value: lines });
        }

        if (locations.length > 0) {
            const lines = locations.map(m => {
                const icon = ROLE_ICONS[m.role as AffiliationRole] || '📍';
                const label = ROLE_LABELS[m.role as AffiliationRole] || m.role;
                return `${icon} **${m.entity_name || `ID:${m.entity_id}`}** (${label})`;
            }).join('\n');
            embed.addFields({ name: "📍 Luoghi", value: lines });
        }

        await factionInt.update({ content: null, embeds: [embed], components: [] });
    });
}

/**
 * OF FLOW: Select Type -> Select Entity -> Show Embed
 */
export async function startInteractiveAffiliateOf(ctx: CommandContext, originInteraction?: MessageComponentInteraction) {
    const rowType = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('of_type_npc').setLabel('👤 NPC').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('of_type_location').setLabel('📍 Luogo').setStyle(ButtonStyle.Primary)
        );

    let activeMessage: Message;
    if (originInteraction) {
        if (originInteraction.replied || originInteraction.deferred) {
            activeMessage = await originInteraction.editReply({ content: "1️⃣ **Di quale tipo di entità vuoi vedere le affiliazioni?**", components: [rowType], embeds: [] }) as Message;
        } else {
            await originInteraction.update({ content: "1️⃣ **Di quale tipo di entità vuoi vedere le affiliazioni?**", components: [rowType], embeds: [] });
            activeMessage = originInteraction.message as Message;
        }
    } else {
        activeMessage = await ctx.message.reply({ content: "1️⃣ **Di quale tipo di entità vuoi vedere le affiliazioni?**", components: [rowType] });
    }

    const collector = activeMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (i: MessageComponentInteraction) => i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (typeInteract: ButtonInteraction) => {
        const type = typeInteract.customId === 'of_type_npc' ? 'npc' : 'location';

        await selectEntityInteractive(ctx, typeInteract, type, async (entityInt, entityId, entityName) => {
            const affiliations = factionRepository.getEntityFactions(type as any, entityId);

            if (affiliations.length === 0) {
                await entityInt.update({ content: `❌ **${entityName}** non appartiene a nessuna fazione.`, components: [] });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`⚔️ Fazioni di "${entityName}"`)
                .setColor("#3498DB");

            const list = affiliations.map(a => {
                const icon = ROLE_ICONS[a.role as AffiliationRole] || '🏴';
                const label = ROLE_LABELS[a.role as AffiliationRole] || a.role;
                return `${icon} **${a.faction_name}** (${label})`;
            }).join('\n');

            embed.setDescription(list);

            await entityInt.update({ content: null, embeds: [embed], components: [] });
        });
    });
}

async function selectRoleInteractive(
    ctx: CommandContext,
    interaction: MessageComponentInteraction,
    entityType: 'npc' | 'location',
    onSelect: (role: AffiliationRole) => Promise<void>
) {
    const npcRoles: { value: AffiliationRole, label: string }[] = [
        { value: 'MEMBER', label: 'Membro' },
        { value: 'LEADER', label: 'Leader' },
        { value: 'ALLY', label: 'Alleato' },
        { value: 'ENEMY', label: 'Nemico' },
        { value: 'PRISONER', label: 'Prigioniero' }
    ];

    const locationRoles: { value: AffiliationRole, label: string }[] = [
        { value: 'HQ', label: 'Sede (HQ)' },
        { value: 'CONTROLLED', label: 'Controllo' },
        { value: 'PRESENCE', label: 'Presenza/Influenza' },
        { value: 'HOSTILE', label: 'Ostile/Nemico' }
    ];

    const roles = entityType === 'npc' ? npcRoles : locationRoles;

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('sel_role')
                .setPlaceholder('Seleziona Ruolo...')
                .addOptions(roles.map(r =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(r.label)
                        .setValue(r.value)
                        .setEmoji(ROLE_ICONS[r.value])
                ))
        );

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: "4️⃣ **Che ruolo ricopre?**", components: [row], embeds: [] });
    } else {
        await interaction.update({ content: "4️⃣ **Che ruolo ricopre?**", components: [row], embeds: [] });
    }

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i: MessageComponentInteraction) => i.customId === 'sel_role' && i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (selInt: StringSelectMenuInteraction) => {
        const role = selInt.values[0] as AffiliationRole;
        await selInt.update({ content: "⏳ Salvataggio...", components: [] });
        await onSelect(role);
    });
}
