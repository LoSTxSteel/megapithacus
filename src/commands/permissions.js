const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  buildPermissionsMessage,
  handlePermissionsHubInteraction,
  permissionsOverview,
} = require('../management/permissionsHub');
const { isGuildOwner } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Set which roles can use staff bot features')
    // Visibility hint — execute/handlers enforce Discord server owner
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isGuildOwner(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed('Only the **Discord server owner** can edit bot permissions.'),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    await interaction.reply(buildPermissionsMessage(interaction.guildId));
  },

  handlePermissionsInteraction: handlePermissionsHubInteraction,
  permissionsOverview,
};
