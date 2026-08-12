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
import { Locale, t, eventTypeLabel, getCampaignLocale } from '../../i18n';

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

export function getRoleLabel(locale: Locale, role: string): string {
    return eventTypeLabel(locale, role);
}

export function getAffiliationEntityTypeLabel(locale: Locale, type: string): string {
    if (type === 'location' || type === 'loc') return t(locale, 'entity.place');
    if (type === 'pc') return t(locale, 'entity.character');
    return t(locale, 'entity.npc');
}

/**
 * Main Interactive Menu for $affiliate
 */
export async function startInteractiveAffiliate(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_aff_add')
                .setLabel(t(ctx.locale, 'affiliate.btnAdd'))
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('btn_aff_remove')
                .setLabel(t(ctx.locale, 'affiliate.btnRemove'))
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('btn_aff_list')
                .setLabel(t(ctx.locale, 'affiliate.btnList'))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('btn_aff_check')
                .setLabel(t(ctx.locale, 'affiliate.btnCheck'))
                .setStyle(ButtonStyle.Secondary)
        );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'affiliate.interactiveTitle'),
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
            new ButtonBuilder().setCustomId('type_npc').setLabel(t(ctx.locale, 'affiliate.typeNpc')).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('type_location').setLabel(t(ctx.locale, 'affiliate.typeLocation')).setStyle(ButtonStyle.Primary)
        );

    let activeMessage: Message;
    if (originInteraction) {
        if (originInteraction.replied || originInteraction.deferred) {
            activeMessage = await originInteraction.editReply({ content: t(ctx.locale, 'affiliate.pickType'), components: [rowType] }) as Message;
        } else {
            await originInteraction.update({ content: t(ctx.locale, 'affiliate.pickType'), components: [rowType] });
            activeMessage = originInteraction.message as Message;
        }
    } else {
        activeMessage = await ctx.message.reply({ content: t(ctx.locale, 'affiliate.pickType'), components: [rowType] });
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
                        const campaignLocale = getCampaignLocale(ctx.activeCampaign!.id);
                        factionRepository.addFactionEvent(
                            ctx.activeCampaign!.id,
                            factionName,
                            null,
                            t(campaignLocale, 'ingest.affiliationJoined', {
                                type: getAffiliationEntityTypeLabel(campaignLocale, type),
                                name: entityName,
                                role: getRoleLabel(campaignLocale, role),
                            }),
                            'MEMBER_JOIN',
                            true
                        );
                        const roleLabel = getRoleLabel(ctx.locale, role);
                        // Safe reply via interaction
                        if (factionInt.replied || factionInt.deferred) {
                            await factionInt.followUp(t(ctx.locale, 'affiliate.addedInteractive', { entity: entityName, role: roleLabel, faction: factionName }));
                        } else {
                            // Note: selectRoleInteractive updates to "Salvataggio...", so we can edit/followUp
                            await factionInt.editReply({ content: t(ctx.locale, 'affiliate.addedInteractive', { entity: entityName, role: roleLabel, faction: factionName }), components: [] });
                        }
                    } else {
                        if (factionInt.replied || factionInt.deferred) {
                            await factionInt.followUp(t(ctx.locale, 'affiliate.errorMaybeExists'));
                        } else {
                            await factionInt.editReply({ content: t(ctx.locale, 'affiliate.errorMaybeExists'), components: [] });
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
            new ButtonBuilder().setCustomId('type_npc').setLabel(t(ctx.locale, 'affiliate.typeNpc')).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('type_location').setLabel(t(ctx.locale, 'affiliate.typeLocation')).setStyle(ButtonStyle.Primary)
        );

    let activeMessage: Message;
    if (originInteraction) {
        if (originInteraction.replied || originInteraction.deferred) {
            activeMessage = await originInteraction.editReply({ content: t(ctx.locale, 'affiliate.pickTypeRemove'), components: [rowType] }) as Message;
        } else {
            await originInteraction.update({ content: t(ctx.locale, 'affiliate.pickTypeRemove'), components: [rowType] });
            activeMessage = originInteraction.message as Message;
        }
    } else {
        activeMessage = await ctx.message.reply({ content: t(ctx.locale, 'affiliate.pickTypeRemove'), components: [rowType] });
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
                await entityInt.followUp({ content: t(ctx.locale, 'affiliate.entityNoAffiliations', { name: entityName }), ephemeral: true });
                return;
            }

            const options = affiliations.map(a =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(a.faction_name || '?')
                    .setDescription(t(ctx.locale, 'affiliate.roleLabel', { role: getRoleLabel(ctx.locale, a.role) }))
                    .setValue(a.faction_id.toString())
                    .setEmoji(ROLE_ICONS[a.role as AffiliationRole] || '🔗')
            );

            const row = new ActionRowBuilder<StringSelectMenuBuilder>()
                .addComponents(new StringSelectMenuBuilder().setCustomId('sel_remove_aff').setPlaceholder(t(ctx.locale, 'affiliate.pickFactionRemove')).addOptions(options));

            await entityInt.update({ content: t(ctx.locale, 'affiliate.pickFactionForEntity', { name: entityName }), components: [row] });

            const selCol = entityInt.message.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                filter: (i) => i.user.id === ctx.message.author.id,
                time: 60000,
                max: 1
            });

            selCol.on('collect', async (selInt: StringSelectMenuInteraction) => {
                const factionId = parseInt(selInt.values[0]);
                const factionName = affiliations.find(a => a.faction_id === factionId)?.faction_name || '?';

                const success = factionRepository.removeAffiliation(factionId, type as any, entityId);

                if (success) {
                    const campaignLocale = getCampaignLocale(ctx.activeCampaign!.id);
                    factionRepository.addFactionEvent(
                        ctx.activeCampaign!.id,
                        factionName,
                        null,
                        t(campaignLocale, 'ingest.affiliationLeft', {
                            type: getAffiliationEntityTypeLabel(campaignLocale, type),
                            name: entityName,
                        }),
                        'MEMBER_LEAVE',
                        true
                    );
                    await selInt.update({ content: t(ctx.locale, 'affiliate.removedInteractive', { entity: entityName, faction: factionName }), components: [] });
                } else {
                    await selInt.update({ content: t(ctx.locale, 'affiliate.removeError'), components: [] });
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
            await interaction.reply({ content: t(ctx.locale, 'affiliate.noEntityOfType', { type: getAffiliationEntityTypeLabel(ctx.locale, type) }), ephemeral: true });
        }
        return;
    }

    const typeLabel = getAffiliationEntityTypeLabel(ctx.locale, type);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(new StringSelectMenuBuilder().setCustomId('sel_entity').setPlaceholder(t(ctx.locale, 'affiliate.selectEntity', { type: typeLabel })).addOptions(options));

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: t(ctx.locale, 'affiliate.selectEntityStep', { type: typeLabel }), components: [row], embeds: [] });
    } else {
        await interaction.update({ content: t(ctx.locale, 'affiliate.selectEntityStep', { type: typeLabel }), components: [row], embeds: [] });
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
        const label = options.find(o => o.data.value === id.toString())?.data.label || '?';
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
            await interaction.followUp({ content: t(ctx.locale, 'affiliate.noFactions'), ephemeral: true });
        }
        return;
    }

    const options = factions.map(f =>
        new StringSelectMenuOptionBuilder()
            .setLabel(f.name)
            .setValue(f.id.toString())
            .setDescription(f.type ? eventTypeLabel(ctx.locale, f.type) : t(ctx.locale, 'entity.faction'))
            .setEmoji('🏴')
    );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(new StringSelectMenuBuilder().setCustomId('sel_faction').setPlaceholder(t(ctx.locale, 'affiliate.pickFaction')).addOptions(options));

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: t(ctx.locale, 'affiliate.whichFaction'), components: [row], embeds: [] });
    } else {
        await interaction.update({ content: t(ctx.locale, 'affiliate.whichFaction'), components: [row], embeds: [] });
    }

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i: MessageComponentInteraction) => i.customId === 'sel_faction' && i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (selInt: StringSelectMenuInteraction) => {
        const id = parseInt(selInt.values[0]);
        const name = factions.find(f => f.id === id)?.name || '?';
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
            await factionInt.update({ content: t(ctx.locale, 'affiliate.noMembers', { name: factionName }), components: [] });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(t(ctx.locale, 'affiliate.membersTitle', { name: factionName }))
            .setColor("#E67E22");

        const npcs = members.filter(m => m.entity_type === 'npc');
        const locations = members.filter(m => m.entity_type === 'location');

        if (npcs.length > 0) {
            const lines = npcs.map(m => {
                const icon = ROLE_ICONS[m.role as AffiliationRole] || '👤';
                const label = getRoleLabel(ctx.locale, m.role);
                // We don't have the entity name here, butgetRepository.getFactionMembers usually returns enough data if updated.
                // Looking at repository, let's assume we need to join or assume entity name is in the result.
                return `${icon} **${m.entity_name || `ID:${m.entity_id}`}** (${label})`;
            }).join('\n');
            embed.addFields({ name: t(ctx.locale, 'affiliate.npcSection'), value: lines });
        }

        if (locations.length > 0) {
            const lines = locations.map(m => {
                const icon = ROLE_ICONS[m.role as AffiliationRole] || '📍';
                const label = getRoleLabel(ctx.locale, m.role);
                return `${icon} **${m.entity_name || `ID:${m.entity_id}`}** (${label})`;
            }).join('\n');
            embed.addFields({ name: t(ctx.locale, 'affiliate.locationsSection'), value: lines });
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
            new ButtonBuilder().setCustomId('of_type_npc').setLabel(`👤 ${t(ctx.locale, 'entity.npc')}`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('of_type_location').setLabel(`📍 ${t(ctx.locale, 'entity.place')}`).setStyle(ButtonStyle.Primary)
        );

    let activeMessage: Message;
    if (originInteraction) {
        if (originInteraction.replied || originInteraction.deferred) {
            activeMessage = await originInteraction.editReply({ content: t(ctx.locale, 'affiliate.pickTypeOf'), components: [rowType], embeds: [] }) as Message;
        } else {
            await originInteraction.update({ content: t(ctx.locale, 'affiliate.pickTypeOf'), components: [rowType], embeds: [] });
            activeMessage = originInteraction.message as Message;
        }
    } else {
        activeMessage = await ctx.message.reply({ content: t(ctx.locale, 'affiliate.pickTypeOf'), components: [rowType] });
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
                await entityInt.update({ content: t(ctx.locale, 'affiliate.entityNoFactions', { icon: '❌', name: entityName }), components: [] });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(t(ctx.locale, 'affiliate.entityFactionsTitle', { icon: '⚔️', name: entityName }))
                .setColor("#3498DB");

            const list = affiliations.map(a => {
                const icon = ROLE_ICONS[a.role as AffiliationRole] || '🏴';
                const label = getRoleLabel(ctx.locale, a.role);
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
    const npcRoles: AffiliationRole[] = ['MEMBER', 'LEADER', 'ALLY', 'ENEMY', 'PRISONER'];
    const locationRoles: AffiliationRole[] = ['HQ', 'CONTROLLED', 'PRESENCE', 'HOSTILE'];

    const roles = entityType === 'npc' ? npcRoles : locationRoles;

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('sel_role')
                .setPlaceholder(t(ctx.locale, 'affiliate.pickRolePlaceholder'))
                .addOptions(roles.map(r =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(getRoleLabel(ctx.locale, r))
                        .setValue(r)
                        .setEmoji(ROLE_ICONS[r])
                ))
        );

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: t(ctx.locale, 'affiliate.pickRole'), components: [row], embeds: [] });
    } else {
        await interaction.update({ content: t(ctx.locale, 'affiliate.pickRole'), components: [row], embeds: [] });
    }

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i: MessageComponentInteraction) => i.customId === 'sel_role' && i.user.id === ctx.message.author.id,
        time: 60000,
        max: 1
    });

    collector.on('collect', async (selInt: StringSelectMenuInteraction) => {
        const role = selInt.values[0] as AffiliationRole;
        await selInt.update({ content: t(ctx.locale, 'affiliate.saving'), components: [] });
        await onSelect(role);
    });
}
