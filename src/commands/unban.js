const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { moderatePlayer } = require('../services/playerModeration');
const { canModeratePlayers } = require('../services/guildPermissions');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');
const { errorEmbed, successEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');
const { resolveBanTarget } = require('./ban');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Remove a player ban on the Nitrado cluster')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('identifier')
        .setDescription('Gamertag, character name, specimen, or player id')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ...EPHEMERAL });

    if (!canModeratePlayers(interaction)) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `You need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or **Ban Members** to use \`/unban\`.`
          ),
        ],
      });
      return;
    }

    const identifier = interaction.options.getString('identifier', true);
    const resolved = resolveBanTarget(interaction.guildId, identifier);
    if (!resolved.ok) {
      await interaction.editReply({
        embeds: [errorEmbed(resolved.error)],
      });
      return;
    }

    const result = await moderatePlayer(interaction.guild, {
      profileId: resolved.profile.id,
      action: 'unban',
      moderator: interaction.user,
      reason: 'Unbanned via /unban',
    });

    if (!result.ok) {
      await interaction.editReply({
        embeds: [errorEmbed(result.error || 'Unban failed.')],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        successEmbed(
          'Unban complete',
          result.message,
          getGuild(interaction.guildId)
        ),
      ],
    });
  },
};
