import { Client, TextChannel, ChannelType, EmbedBuilder } from 'discord.js';
import { config } from '../config';

// Track guilds that have already received welcome message (prevents duplicates)
const welcomedGuilds = new Set<string>();

// Clear welcomed status after 5 minutes (allows re-sending if needed after restart)
const WELCOME_DEBOUNCE_MS = 5 * 60 * 1000;

export function markGuildAsWelcomed(guildId: string): void {
    welcomedGuilds.add(guildId);
    setTimeout(() => welcomedGuilds.delete(guildId), WELCOME_DEBOUNCE_MS);
}

export function hasBeenWelcomed(guildId: string): boolean {
    return welcomedGuilds.has(guildId);
}

export function buildWelcomeEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle("🎭 Benvenuto! Sono Lestapenna, il bardo digitale.")
        .setColor("#9B59B6")
        .setDescription(
            "Registro le vostre sessioni di D&D, le trascrivo e creo riassunti narrativi. " +
            "Prima di iniziare, serve una breve configurazione."
        )
        .addFields(
            {
                name: "📌 PASSO 1: Configura i canali",
                value:
                    "Vai nel canale desiderato e scrivi:\n" +
                    "• `$setcmd` — dove riceverò i comandi\n" +
                    "• `$setsummary` — dove pubblicherò i riassunti\n\n" +
                    "*Puoi usare lo stesso canale per entrambi.*",
                inline: false
            },
            {
                name: "📌 PASSO 2: Crea la campagna",
                value:
                    "```\n$creacampagna Nome della Campagna\n$selezionacampagna Nome della Campagna\n```",
                inline: false
            },
            {
                name: "📌 PASSO 3: Registra i partecipanti",
                value:
                    "Il **Dungeon Master** scrive:\n`$sono DM`\n\n" +
                    "Ogni **giocatore** scrive:\n`$sono Nome Personaggio`",
                inline: false
            },
            {
                name: "📌 PASSO 4: Configura il mondo (opzionale)",
                value:
                    "• `$setworld` — per impostare interattivamente anno, luogo e party\n" +
                    "• `$anno0 La Caduta dell'Impero` — evento cardine della timeline\n" +
                    "• `$data 1247` — anno corrente\n" +
                    "• `$luogo Waterdeep | Taverna del Portale` — posizione iniziale\n" +
                    "• `$faction rename party | I Cavalieri dell'Alba` — nome del party\n\n" +
                    "*Tutto questo può essere modificato in seguito.*",
                inline: false
            },
            {
                name: "📌 PASSO 5: Configura le email (opzionale)",
                value:
                    "Per ricevere i recap via email:\n" +
                    "• `$setemail email1@ex.com, email2@ex.com` — email per tutto il server\n\n" +
                    "*Ogni giocatore può anche impostare la propria email con `$sono` → Completa Scheda.*",
                inline: false
            },
            {
                name: "🎙️ AVVIARE UNA SESSIONE",
                value:
                    "Quando siete pronti, il DM entra nel canale vocale e scrive:\n" +
                    "```\n$ascolta\n```\n" +
                    "Per terminare: `$termina` — il riassunto verrà generato automaticamente.",
                inline: false
            }
        )
        .setFooter({
            text: "⚠️ Finché non configuri i canali ($setcmd), non risponderò ad altri comandi."
        });
}

export function registerGuildJoinHandler(client: Client) {
    client.on('guildCreate', async (guild) => {
        console.log(`[GuildJoin] Bot aggiunto al server: ${guild.name} (${guild.id})`);

        // DEV_GUILD_ID: If set, only handle that specific guild
        if (config.discord.devGuildId && guild.id !== config.discord.devGuildId) {
            console.log(`[GuildJoin] DEV_GUILD_ID attivo, ignoro server ${guild.name}`);
            return;
        }

        // IGNORE_GUILD_IDS: Skip these guilds
        if (config.discord.ignoreGuildIds.includes(guild.id)) {
            console.log(`[GuildJoin] Server ${guild.name} in ignore list, skip`);
            return;
        }

        // Check debounce to prevent duplicate messages
        if (hasBeenWelcomed(guild.id)) {
            console.log(`[GuildJoin] Server ${guild.name} già notificato di recente, skip.`);
            return;
        }

        // Try to find a suitable channel to send the welcome message
        // Priority: system channel > first text channel where we can send
        let targetChannel: TextChannel | null = null;

        if (guild.systemChannel) {
            targetChannel = guild.systemChannel;
        } else {
            // Find first text channel we have permission to send to
            const textChannels = guild.channels.cache
                .filter(ch => ch.type === ChannelType.GuildText)
                .filter(ch => {
                    const perms = ch.permissionsFor(client.user!);
                    return perms?.has('SendMessages') && perms?.has('ViewChannel');
                });

            if (textChannels.size > 0) {
                targetChannel = textChannels.first() as TextChannel;
            }
        }

        if (targetChannel) {
            try {
                await targetChannel.send({ embeds: [buildWelcomeEmbed()] });
                markGuildAsWelcomed(guild.id);
                console.log(`[GuildJoin] Messaggio di benvenuto inviato in #${targetChannel.name}`);
            } catch (e) {
                console.error(`[GuildJoin] Impossibile inviare messaggio di benvenuto:`, e);
            }
        } else {
            console.warn(`[GuildJoin] Nessun canale disponibile per il messaggio di benvenuto in ${guild.name}`);
        }
    });
}
