const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { searchPlayers, getPlayerById } = require('../services/playerDb');
const { brand } = require('../config');
const { errorEmbed } = require('../utils/embeds');

function profileEmbed(profile) {
  return new EmbedBuilder()
    .setColor(brand.color)
    .setTitle(profile.characterName || profile.gamertag || 'Unknown player')
    .setDescription(
      profile.notes === 'FAKE_TEST_PROFILE'
        ? '_Fake test profile for Megapithacus development._'
        : 'Player profile from backend join logging.'
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
    )
    .setFooter({ text: 'Megapithacus · Player DB' })
    .setTimestamp();
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

function profilePayload(profile) {
  return {
    embeds: [profileEmbed(profile)],
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
        await interaction.reply(profilePayload(results[0]));
        return;
      }

      const list = results
        .map(
          (p, i) =>
            `**${i + 1}.** ${p.characterName || 'Unknown'} · \`${p.gamertag || '—'}\` · implant \`${
              p.specimenImplant || '—'
            }\` · ${p.tribeName || 'No tribe'} · ${p.map || '—'}`
        )
        .join('\n');

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(brand.accent)
            .setTitle(`Player search — ${results.length} result(s)`)
            .setDescription(list)
            .setFooter({ text: 'Pick a player below to open their profile' }),
        ],
        components: [resultsPicker(results)],
        ephemeral: true,
      });
    }
  },
};
