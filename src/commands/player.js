const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { searchPlayers, getPlayerById } = require('../services/playerDb');
const {
  listBansForPlayer,
  findActiveBanForPlayer,
  durationMeta,
} = require('../services/banStore');
const { errorEmbed, brandEmbed, guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function kickLinesFromNotes(notes) {
  if (!notes || notes === 'FAKE_TEST_PROFILE') return [];
  return String(notes)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\]\s*KICK\b/i.test(line));
}

function formatBanLine(ban) {
  const when = ban.startsAt || ban.createdAt;
  const ts = when
    ? `<t:${Math.floor(new Date(when).getTime() / 1000)}:d>`
    : '—';
  const meta = ban.durationValue ? durationMeta(ban.durationValue) : null;
  const duration =
    ban.duration || meta?.label || (ban.endsAt ? 'Timed' : 'Permanent');
  const status = ban.active
    ? '**Active**'
    : ban.unbannedAt
      ? 'Lifted'
      : 'Expired';
  const reason = (ban.reason || 'No reason').slice(0, 80);
  return `• ${ts} · Ban (${duration}) · ${status} · ${reason}`;
}

function formatKickLine(line) {
  // [ISO] KICK by tag: reason
  const match = line.match(
    /^\[([^\]]+)\]\s*KICK\s+by\s+([^:]+):\s*(.*)$/i
  );
  if (!match) return `• Kick · ${line.slice(0, 100)}`;
  const [, iso, by, reason] = match;
  const t = new Date(iso).getTime();
  const when = Number.isFinite(t)
    ? `<t:${Math.floor(t / 1000)}:d>`
    : iso.slice(0, 10);
  return `• ${when} · Kick · ${(reason || 'No reason').slice(0, 80)} · by ${by.trim()}`;
}

function punishmentHistoryLines(guildId, profile, limit = 8) {
  const bans = listBansForPlayer(guildId, profile);
  const kicks = kickLinesFromNotes(profile.notes);

  const items = [
    ...bans.map((ban) => ({
      at: new Date(ban.startsAt || ban.createdAt || 0).getTime() || 0,
      line: formatBanLine(ban),
    })),
    ...kicks.map((line) => {
      const match = line.match(/^\[([^\]]+)\]/);
      const at = match ? new Date(match[1]).getTime() : 0;
      return {
        at: Number.isFinite(at) ? at : 0,
        line: formatKickLine(line),
      };
    }),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  return items.map((i) => i.line);
}

function punishmentSummary(guildId, profile) {
  const bans = listBansForPlayer(guildId, profile);
  const kicks = kickLinesFromNotes(profile.notes);
  const active = findActiveBanForPlayer(guildId, profile);
  const total = bans.length + kicks.length;
  if (!total) return null;
  if (active) return `Banned · ${total} record${total === 1 ? '' : 's'}`;
  return `${total} past punishment${total === 1 ? '' : 's'}`;
}

function profileEmbed(profile, guildId) {
  const guild = guildId ? getGuild(guildId) : null;
  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle(profile.characterName || profile.gamertag || 'Unknown player')
      .setDescription(
        profile.notes === 'FAKE_TEST_PROFILE'
          ? '_Fake test profile for Megapithacus development._'
          : 'Player profile from join logging.'
      )
      .addFields(
        { name: 'Xbox Gamertag', value: profile.gamertag || '—', inline: true },
        { name: 'In-game name', value: profile.characterName || '—', inline: true },
        {
          name: 'Specimen Implant',
          value: profile.specimenImplant ? `\`${profile.specimenImplant}\`` : '—',
          inline: true,
        },
        { name: 'Tribe', value: profile.tribeName || '—', inline: true },
        { name: 'Tribe ID', value: profile.tribeId ? `\`${profile.tribeId}\`` : '—', inline: true },
        { name: 'Map', value: profile.map || '—', inline: true },
        { name: 'Online', value: profile.online ? '🟢 Yes' : '🔴 No', inline: true },
        {
          name: 'First seen',
          value: profile.firstSeen
            ? `<t:${Math.floor(new Date(profile.firstSeen).getTime() / 1000)}:f>`
            : '—',
          inline: true,
        },
        {
          name: 'Last join',
          value: profile.lastJoin
            ? `<t:${Math.floor(new Date(profile.lastJoin).getTime() / 1000)}:R>`
            : '—',
          inline: true,
        }
      ),
    guild,
    { context: 'Player DB' }
  );

  if (guildId) {
    const history = punishmentHistoryLines(guildId, profile);
    embed.addFields({
      name: 'Past punishments',
      value: history.length
        ? history.join('\n').slice(0, 1024)
        : '_No bans or kicks on record._',
    });
  }

  return embed;
}

function moderationMenu(profileId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`player:mod:${profileId}`)
      .setPlaceholder('Ban, unban, or kick this player')
      .addOptions(
        {
          label: 'Ban',
          description: 'Ban this player from the cluster',
          value: 'ban',
        },
        {
          label: 'Unban',
          description: 'Lift a ban and create an unban log',
          value: 'unban',
        },
        {
          label: 'Kick',
          description: 'Kick this player from the game server',
          value: 'kick',
        }
      )
  );
}

function profilePayload(profile, guildId) {
  return {
    embeds: [profileEmbed(profile, guildId)],
    components: [moderationMenu(profile.id)],
    ephemeral: true,
  };
}

function resultsPicker(results) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('player:pick')
      .setPlaceholder('Select a player to view')
      .addOptions(
        results.slice(0, 25).map((p) => ({
          label: (p.characterName || p.gamertag || 'Unknown').slice(0, 100),
          description: `${p.gamertag || '—'} · ${p.map || 'No map'}`.slice(0, 100),
          value: p.id,
        }))
      )
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('player')
    .setDescription('Player database tools')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Search players by gamertag, IGN, implant, tribe, map, etc.')
        .addStringOption((opt) =>
          opt
            .setName('query')
            .setDescription('Any piece of player info')
            .setRequired(true)
        )
    ),

  profilePayload,
  profileEmbed,
  moderationMenu,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'search') {
      const query = interaction.options.getString('query', true);
      const results = searchPlayers(guildId, query).slice(0, 25);

      if (!results.length) {
        await interaction.reply({
          embeds: [errorEmbed(`No players matched \`${query}\`.`)],
          ephemeral: true,
        });
        return;
      }

      if (results.length === 1) {
        await interaction.reply(profilePayload(results[0], guildId));
        return;
      }

      const list = results
        .map((p, i) => {
          const punish = punishmentSummary(guildId, p);
          const punishBit = punish ? ` · ⚠ ${punish}` : '';
          return `**${i + 1}.** ${p.characterName || 'Unknown'} · \`${
            p.gamertag || '—'
          }\` · implant \`${p.specimenImplant || '—'}\` · ${
            p.tribeName || 'No tribe'
          } · ${p.map || '—'}${punishBit}`;
        })
        .join('\n');

      await interaction.reply({
        embeds: [
          guildEmbed(getGuild(guildId), `Player search — ${results.length} result(s)`, {
            accent: true,
            context: 'Player DB',
          }).setDescription(
            `${list.slice(0, 3900)}\n\n_Select a player below to open their profile._`
          ),
        ],
        components: [resultsPicker(results)],
        ephemeral: true,
      });
    }
  },
};
